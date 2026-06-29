/* Keel build step.
   You keep editing index.html at the repo root and committing as usual.
   On each deploy Netlify runs this, which copies everything into dist/
   and minifies dist/index.html. Netlify publishes dist/. You never touch dist/. */
const fs = require('fs');
const path = require('path');
const { minify } = require('html-minifier-terser');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const SKIP = new Set([
  'node_modules', 'dist', '.git', '.gitignore',
  'package.json', 'package-lock.json', 'build.js', 'netlify.toml',
]);

async function run() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Copy every root asset (except build tooling) into dist so nothing gets dropped.
  for (const name of fs.readdirSync(ROOT)) {
    if (SKIP.has(name)) continue;
    fs.cpSync(path.join(ROOT, name), path.join(OUT, name), { recursive: true });
  }

  const indexPath = path.join(OUT, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error('index.html not found at repo root');

  const src = fs.readFileSync(indexPath, 'utf8');
  const before = src.length;
  const out = await minify(src, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    // mangle:false is the key safety guarantee — never rename cross-block globals.
    minifyJS: { compress: true, mangle: false },
    caseSensitive: true,
    keepClosingSlash: true,
  });
  fs.writeFileSync(indexPath, out);

  const pct = (100 * (1 - out.length / before)).toFixed(1);
  console.log(`Keel build: index.html ${before.toLocaleString()} -> ${out.length.toLocaleString()} bytes (${pct}% smaller)`);
}

run().catch((e) => { console.error('Build failed:', e); process.exit(1); });
