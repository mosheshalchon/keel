// ─────────────────────────────────────────────────────────────────────────────
// sync-sales-actuals — Dropbox CSV → sales_actuals (+ daily pacing snapshot)
//
// CHANGED 2026-08-25. Sales Pacing had not updated since Aug 13 and nothing
// anywhere said so. Three layers all reported success:
//   • pg_cron logged "succeeded" — it only means net.http_post returned an id
//   • net._http_response held status_code NULL — pg_net's 5s timeout gave up
//     long before the function answered, so the body was never captured
//   • jsonResp returns HTTP 200 on every failure (a deliberate workaround for
//     the Supabase Test panel, which cannot render a non-2xx body)
// The actual error was 422 "Missing required columns": the NetSuite saved search
// had been changed. "description" became "product", and the period column
// "Formula (Text)" became "date code1"/"date code2". The parser looked for
// columns that no longer existed, wrote nothing, and said nothing.
//
// Two fixes here: the column aliases below, and — more importantly — the
// response now names the columns it resolved. A future rename shows up as a
// wrong mapping in the output instead of twelve silent days.
//
// CHANGED 2026-08-10. The previous version relied on
//   .upsert(chunk, { onConflict: "brand_id,dimension,entity,month,status" })
// to make re-runs idempotent. That only works if a unique index covers exactly
// those columns AND none of them are NULL — a unique index treats NULLs as
// distinct, so every run inserted fresh rows instead of updating. Result: each
// cron run stacked another copy on top of the last and every total inflated.
// August 2026 read $2,065,230 against a source file of $1,888,863.
//
// This version does not depend on any constraint. Per month it DELETEs this
// source's rows and then INSERTs the freshly aggregated set:
//   • months absent from the file keep their history
//   • entities that disappear from the source are correctly removed
//   • re-running the same file is a no-op, not a doubling
//   • a mid-run failure can only affect the month it is on
//
// Cell identity is brand × dimension × entity × month × STATUS. Status stays in
// the key: one customer legitimately has a Billed row AND a Pending Fulfillment
// row in the same month (UNFI-EAST Aug 2026 = $39,189.84 Billed + $467,930.66
// Pending Fulfillment). Collapsing status would drop real money.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function monthKeyFromCode(s: string): string | null {
  const t = String(s || "").trim();
  if (/^\d{6}$/.test(t)) {
    const y = Number(t.slice(0, 4)), m = Number(t.slice(4, 6));
    // Guard the year too — document numbers and UPC fragments are also 6 digits.
    if (m >= 1 && m <= 12 && y >= 2000 && y <= 2100) return `${y}-${String(m).padStart(2, "0")}-01`;
  }
  return null;
}

function monthKeyFromLabel(s: string): string | null {
  const t = String(s || "").trim();
  const m = t.match(/^([A-Za-z]{3,})[\s\-\/]+(\d{2,4})$/);
  if (m) {
    const idx = MONTHS_SHORT.findIndex(mm => m[1].toLowerCase().startsWith(mm.toLowerCase()));
    if (idx >= 0) { let y = Number(m[2]); if (y < 100) y += 2000; return `${y}-${String(idx + 1).padStart(2, "0")}-01`; }
  }
  return null;
}

// A real date in the export ("8/13/2026", "2026-08-13") is also a month source.
// The old parser only understood a 6-digit period code and a "Aug 2026" label,
// so when the period column disappeared it had nothing left to fall back on.
function monthKeyFromDate(s: string): string | null {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]);
    if (mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) return `${y}-${String(mo).padStart(2, "0")}-01`;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    const mo = Number(m[1]);
    if (mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) return `${y}-${String(mo).padStart(2, "0")}-01`;
  }
  return null;
}

function parseAmount(raw: string): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}

// UPC may arrive as scientific notation (8.92453E+11) or with stray chars.
function normalizeUpc(raw: string): string {
  let s = String(raw || "").trim();
  if (/e\+?\d+/i.test(s)) {
    const n = Number(s);
    if (isFinite(n)) s = n.toLocaleString("fullwide", { useGrouping: false });
  }
  return s.replace(/[^0-9]/g, "");
}

// ALWAYS HTTP 200, with ok:false in the body on failure.
// The Supabase dashboard's Test panel cannot render the body of a non-2xx
// response — it throws its own "Cannot read properties of undefined (reading
// 'error')" and shows that instead, so every failure looked identical and the
// real message was invisible. Console output doesn't reach the Logs tab either.
// Returning 200 makes the panel print the body, which is the only diagnostic
// channel that actually works here.
//
// THE COST, learned the hard way: pg_cron and net._http_response both read this
// as success, so a broken run is indistinguishable from a good one at every
// layer above the body. Anything monitoring this function must read body.ok —
// never the status code. The Sales Pacing screen should show the last
// SUCCESSFUL write, not the last run.
function jsonResp(body: unknown, status = 200): Response {
  const payload = (status >= 400 && body && typeof body === "object")
    ? { ok: false, httpStatus: status, ...(body as Record<string, unknown>) }
    : body;
  return new Response(JSON.stringify(payload, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
}

export type Cell = {
  dimension: string; entity: string; upc: string | null;
  month: string; status: string; amount: number; units: number;
};

/**
 * CSV text → aggregated cells. Pure and exported so it can be tested without
 * touching Dropbox or the database.
 *
 * Returns `resolved`: the header each required field actually matched. That is
 * the diagnostic this function lacked — when the saved search was changed on
 * Aug 13 the only symptom was silence, and a mapping printed in every response
 * turns the next rename into something visible on the first run.
 */
export function buildCells(text: string): {
  cells: Cell[]; hdr: string[]; hdrIdx: number; lineRows: number;
  resolved?: Record<string, string>; skipped?: Record<string, number>; error?: string;
} {
  const aoa = parseCSV(text);
  if (aoa.length < 2) return { cells: [], hdr: [], hdrIdx: -1, lineRows: 0, error: "CSV had no data rows" };

  // Find the header row. Accept the flat export (Amount / Quantity / Customer /
  // Status), the old pivot export (Sum of Amount / Sum of Quantity), and the
  // order-level export that replaced them (Product / Amount / Customer).
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(8, aoa.length); i++) {
    const joined = aoa[i].map(x => String(x || "").toLowerCase()).join("|");
    const hasAmount = /\bamount\b/.test(joined);
    const hasQty = /\bquantity\b/.test(joined);
    const hasCust = /customer/.test(joined);
    const hasStatus = /\bstatus\b/.test(joined);
    if (hasAmount && hasCust && (hasQty || hasStatus)) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) return { cells: [], hdr: [], hdrIdx: -1, lineRows: 0, error: "Could not find header row (need Amount + Customer columns)" };

  const hdr = aoa[hdrIdx].map(x => String(x || "").trim().toLowerCase());
  const findCol = (...needles: string[]) => hdr.findIndex(h => needles.some(n => h.includes(n)));

  // THE Aug 13 BREAK. The saved search renamed "description" to "product" and
  // dropped "Formula (Text)" in favour of "date code1"/"date code2". Aliases are
  // ordered most-specific first, because findCol takes the first header that
  // CONTAINS the needle: "amount" would otherwise match "discount amount" if the
  // real column happened to sit further right.
  const cDesc = findCol("description", "product");
  const cQty = findCol("sum of quantity", "quantity");
  const cAmt = findCol("sum of amount", "amount");
  const cCust = findCol("customer companyname", "customer");
  const cStatus = findCol("status");
  const cUpc = findCol("upcbol", "upc");
  const cMonth = findCol("formula (text)", "date code", "period", "posting period");

  const resolved: Record<string, string> = {
    product: cDesc >= 0 ? hdr[cDesc] : "(not found)",
    amount: cAmt >= 0 ? hdr[cAmt] : "(not found)",
    customer: cCust >= 0 ? hdr[cCust] : "(not found)",
    quantity: cQty >= 0 ? hdr[cQty] : "(not found)",
    status: cStatus >= 0 ? hdr[cStatus] : "(not found)",
    upc: cUpc >= 0 ? hdr[cUpc] : "(not found)",
    month: cMonth >= 0 ? hdr[cMonth] : "(not found — falling back to scanning every cell)",
  };

  if (cDesc < 0 || cAmt < 0 || cCust < 0) {
    return {
      cells: [], hdr, hdrIdx, lineRows: 0, resolved,
      error: "Missing required columns (need an item column named description/product, plus amount and customer)",
    };
  }

  const monthFromRow = (row: string[]): string | null => {
    if (cMonth >= 0) {
      const k = monthKeyFromCode(row[cMonth]) || monthKeyFromLabel(row[cMonth]) || monthKeyFromDate(row[cMonth]);
      if (k) return k;
    }
    // Ordered deliberately: a 6-digit period code is unambiguous, a month label
    // nearly so, a bare date least — an order date and a ship date in the same
    // row can disagree, so it is the last resort rather than the first hit.
    for (const cell of row) { const k = monthKeyFromCode(cell); if (k) return k; }
    for (const cell of row) { const k = monthKeyFromLabel(cell); if (k) return k; }
    for (const cell of row) { const k = monthKeyFromDate(cell); if (k) return k; }
    return null;
  };

  const agg = new Map<string, Cell>();
  const bump = (dimension: string, entity: string, upc: string, month: string, status: string, amount: number | null, units: number | null) => {
    const k = `${dimension}|${entity}|${month}|${status}`;
    let a = agg.get(k);
    if (!a) { a = { dimension, entity, upc: upc || null, month, status, amount: 0, units: 0 }; agg.set(k, a); }
    if (amount != null) a.amount += amount;
    if (units != null) a.units += units;
    if (upc && !a.upc) a.upc = upc;
  };

  // Rows are dropped for real reasons; counting them means a run that silently
  // parses half the file is visible in the response instead of merely looking small.
  const skipped = { blank: 0, totalRow: 0, noMonth: 0, noValue: 0 };

  let lineRows = 0;
  for (let r = hdrIdx + 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || !row.length) continue;
    const desc = String(row[cDesc] || "").trim();
    const cust = String(row[cCust] || "").trim();
    if (!desc && !cust) { skipped.blank++; continue; }
    if (/^total$/i.test(desc) || /^applied filters/i.test(desc)) { skipped.totalRow++; continue; }
    const month = monthFromRow(row);
    if (!month) { skipped.noMonth++; continue; }
    const amount = parseAmount(row[cAmt]);
    const units = cQty >= 0 ? parseAmount(row[cQty]) : null;
    const status = (cStatus >= 0 ? String(row[cStatus] || "").trim() : "") || "Unspecified";
    const upc = cUpc >= 0 ? normalizeUpc(row[cUpc]) : "";
    if (amount == null && units == null) { skipped.noValue++; continue; }
    lineRows++;
    if (desc) bump("product", desc, upc, month, status, amount, units);
    if (cust) bump("customer", cust, "", month, status, amount, units);
    // CROSS ROWS: product § customer. Lets the app answer "which customers drove
    // this item this month" — impossible from the two flat dimensions above, which
    // are never joined. § cannot occur in a NetSuite item or customer name, so the
    // entity splits back apart unambiguously.
    if (desc && cust) bump("customer_product", desc + " § " + cust, upc, month, status, amount, units);
  }

  // Round once at the end — summing floats then rounding beats rounding each line.
  const cells = [...agg.values()];
  for (const c of cells) {
    c.amount = Math.round(c.amount * 100) / 100;
    c.units = Math.round(c.units * 1000) / 1000;
  }
  return { cells, hdr, hdrIdx, lineRows, resolved, skipped };
}

Deno.serve(async (_req) => {
  try {
    // ?only=core  → product + customer dimensions only (what every total reads)
    // ?only=cross → the customer_product drill-down rows only
    // ?dry=1      → parse and report, write nothing. Use this to check a column
    //               mapping after the saved search changes, without touching data.
    // omitted     → both
    // Splitting exists because the whole job brushed against the wall-clock limit:
    // parsing a 9 MB CSV plus ~100 write round trips took 3m20s and was killed.
    // The cron should call ?only=core and ?only=cross as two scheduled jobs.
    let only = "", dry = false;
    try {
      const u = new URL(_req.url);
      only = u.searchParams.get("only") || "";
      dry = u.searchParams.get("dry") === "1";
    } catch (_e) { /* no url */ }
    const doCore = only !== "cross";
    const doCross = only !== "core";
    const DROPBOX_URL = Deno.env.get("DROPBOX_CSV_URL");
    const BRAND_ID = Deno.env.get("BRAND_ID") || "humanco";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SOURCE = "dropbox";
    if (!DROPBOX_URL) return jsonResp({ error: "DROPBOX_CSV_URL secret not set" }, 500);

    console.log(`[sync] start mode=${only || "both"}${dry ? " DRY" : ""}`);
    const resp = await fetch(DROPBOX_URL, { redirect: "follow" });
    if (!resp.ok) return jsonResp({ error: `Dropbox fetch failed: ${resp.status} ${resp.statusText}` }, 502);
    const text = await resp.text();
    if (/<!DOCTYPE html|<html/i.test(text.slice(0, 200))) {
      return jsonResp({ error: "Dropbox returned HTML, not CSV - link may have expired or isn't a direct-download (dl=1) link." }, 502);
    }

    console.log(`[sync] fetched ${text.length} bytes`);
    const built = buildCells(text);
    console.log(`[sync] parsed: ${built ? (built.cells || []).length : "UNDEFINED RETURN"} cells`);
    if (built.error) return jsonResp({ error: built.error, resolved: built.resolved, headers: built.hdr, headerIndex: built.hdrIdx }, 422);
    const rows = built.cells;
    if (!rows.length) return jsonResp({ error: "Parsed 0 rows", resolved: built.resolved, skipped: built.skipped, headerRow: built.hdr, headerIndex: built.hdrIdx }, 422);

    const core = rows.filter(r => r.dimension !== "customer_product");
    const cross = rows.filter(r => r.dimension === "customer_product");
    const monthsSeen = [...new Set(core.map(r => r.month))].sort();

    // A dry run answers the only question that matters after a schema change:
    // did it read the right columns, and do the months look sane?
    if (dry) {
      return jsonResp({
        ok: true, dry: true, mode: only || "both",
        resolved: built.resolved, skipped: built.skipped,
        lineRows: built.lineRows, cells: rows.length,
        months: monthsSeen,
        totalAmount: Math.round(core.reduce((a, r) => a + r.amount, 0) * 100) / 100,
        sample: core.slice(0, 5),
      });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const now = new Date().toISOString();

    // ── REPLACE, month by month ───────────────────────────────────────────────
    // Deleting is scoped to this source, so manually uploaded cells
    // (source='upload') are a separate layer and survive untouched.
    const byMonth = new Map<string, Cell[]>();
    for (const r of core) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, []);
      byMonth.get(r.month)!.push(r);
    }
    const months = [...byMonth.keys()].sort();

    let written = 0, removed = 0;
    const perMonth: Record<string, { deleted: number; inserted: number }> = {};
    const CHUNK = 500;

    for (const month of (doCore ? months : [])) {
      const monthRows = byMonth.get(month)!;

      const { count: delCount, error: delErr } = await sb.from("sales_actuals")
        .delete({ count: "exact" })
        .eq("brand_id", BRAND_ID).eq("source", SOURCE).eq("month", month)
        // Scope the delete to the dimensions THIS pass rewrites. Without it,
        // ?only=core cleared the customer_product rows for all 51 months and then
        // inserted only the core dimensions — removed 9,472, wrote 2,809, and the
        // drill-down silently emptied. The two passes are meant to be independent
        // (they run as two separate cron jobs); this is what makes them so.
        .neq("dimension", "customer_product");
      if (delErr) return jsonResp({ error: `Delete failed for ${month}: ${delErr.message}`, written, removed }, 500);
      const deleted = delCount || 0;

      let inserted = 0;
      for (let i = 0; i < monthRows.length; i += CHUNK) {
        const chunk = monthRows.slice(i, i + CHUNK).map(m => ({
          brand_id: BRAND_ID, dimension: m.dimension, entity: m.entity, upc: m.upc || null,
          month: m.month, status: m.status, amount: m.amount, units: m.units,
          source: SOURCE, updated_at: now,
        }));
        // No .select() — we already know the row count, and returning ids for every
        // row was a meaningful slice of the wall clock across 50 months.
        const { error } = await sb.from("sales_actuals").insert(chunk);
        if (error) {
          return jsonResp({
            error: `Insert failed for ${month} at chunk ${i}: ${error.message}`,
            warning: `${month} was cleared before this insert — re-run the function to restore it.`,
            written, removed,
          }, 500);
        }
        inserted += chunk.length;
      }

      written += inserted; removed += deleted;
      perMonth[month] = { deleted, inserted };
    }

    // ── Cross rows: product × customer, non-fatal ─────────────────────────────
    // Deliberately NOT per-month like the core pass. These are 6.6k rows; doing 50
    // month-scoped deletes plus 50 chunked inserts added ~100 round trips and pushed
    // the whole function past its wall-clock limit (booted 16:39:43, killed 16:43:03,
    // no completion log). One delete for the whole dimension plus 2k-row inserts is
    // ~5 round trips. Safe to clear wholesale because, unlike the core dimensions,
    // nothing reads these rows for totals — they only power the drill-down, so a
    // brief gap mid-run costs nothing.
    let crossWritten = 0, crossRemoved = 0, crossError: string | null = null;
    try {
      if (!doCross) throw new Error("skipped (only=core)");
      const { count: cDel, error: delErr } = await sb.from("sales_actuals")
        .delete({ count: "exact" })
        .eq("brand_id", BRAND_ID).eq("source", SOURCE).eq("dimension", "customer_product");
      if (delErr) throw delErr;
      crossRemoved = cDel || 0;

      const BIG = 2000;
      for (let i = 0; i < cross.length; i += BIG) {
        const chunk = cross.slice(i, i + BIG).map(m => ({
          brand_id: BRAND_ID, dimension: m.dimension, entity: m.entity, upc: m.upc || null,
          month: m.month, status: m.status, amount: m.amount, units: m.units,
          source: SOURCE, updated_at: now,
        }));
        // No .select() — returning 2k ids per insert is pure round-trip weight.
        const { error } = await sb.from("sales_actuals").insert(chunk);
        if (error) throw error;
        crossWritten += chunk.length;
      }
      console.log(`[sync-sales-actuals] cross: -${crossRemoved} +${crossWritten}`);
    } catch (e) {
      crossError = String((e as Error)?.message || e);
      console.warn("[sync-sales-actuals] customer_product pass failed (core data is fine):", crossError);
    }

    // ── Daily pacing snapshot: current month's MTD per entity, tagged today ────
    let snapWritten = 0;
    try {
      if (!doCore) throw new Error("skipped (only=cross)");
      const today = new Date();
      const curMonthKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const snapDate = today.toISOString().slice(0, 10);
      const snapAgg = new Map<string, { dimension: string; entity: string; amount: number; units: number }>();
      for (const r of core) {
        if (r.month !== curMonthKey) continue;
        const k = `${r.dimension}|${r.entity}`;
        let s = snapAgg.get(k);
        if (!s) { s = { dimension: r.dimension, entity: r.entity, amount: 0, units: 0 }; snapAgg.set(k, s); }
        s.amount += r.amount;
        s.units += r.units;
      }
      const snapRows = [...snapAgg.values()].map(s => ({
        brand_id: BRAND_ID, snapshot_date: snapDate, dimension: s.dimension,
        entity: s.entity, month: curMonthKey, amount: s.amount, units: s.units,
      }));
      // Same replace-don't-append rule: re-running on the same day rewrites
      // today's snapshot rather than duplicating it.
      await sb.from("sales_pacing_snapshots").delete()
        .eq("brand_id", BRAND_ID).eq("snapshot_date", snapDate).eq("month", curMonthKey);
      for (let i = 0; i < snapRows.length; i += 500) {
        const { data } = await sb.from("sales_pacing_snapshots")
          .insert(snapRows.slice(i, i + 500)).select("id");
        snapWritten += data ? data.length : 0;
      }
    } catch (snapErr) {
      console.warn("Pacing snapshot skipped:", String(snapErr));
    }

    return jsonResp({
      ok: true,
      mode: only || "both",
      // Echoed on every run, not just failures. If the saved search is changed
      // again, a wrong mapping is visible here immediately rather than showing up
      // as a screen that quietly stops moving.
      resolved: built.resolved,
      skipped: built.skipped,
      lineRows: built.lineRows,
      cells: rows.length,
      written,
      removed,
      snapshotRows: snapWritten,
      months: months.length,
      monthsSeen,
      totalAmount: Math.round(core.reduce((a, r) => a + r.amount, 0) * 100) / 100,
      crossWritten, crossRemoved, crossError,
      perMonth,
    });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    console.error("[sync] FAILED:", msg, "\n", (e as Error)?.stack || "(no stack)");
    return jsonResp({ error: msg, stack: (e as Error)?.stack || null }, 500);
  }
});
# keel
