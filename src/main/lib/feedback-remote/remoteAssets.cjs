'use strict';

/**
 * remoteAssets.cjs — serves this desktop's own `<app root>/dist-web/` build to an
 * E2E-authenticated browser, so the browser runs exactly the UI of the desktop it talks to.
 * Names are basename-only and realpath-confined; nothing outside dist-web is readable.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.map': 'application/json', '.txt': 'text/plain', '.onnx': 'application/octet-stream',
};

let _rootOverride = null;

/** Same layout rule as index.cjs's dist/index.html lookup: <src/main>/../../dist-web. */
function webRoot() {
  return _rootOverride || path.join(__dirname, '..', '..', '..', '..', 'dist-web');
}

function typeOf(name) {
  return TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function realRoot() {
  try {
    const r = fs.realpathSync(webRoot());
    return fs.statSync(r).isDirectory() ? r : null;
  } catch { return null; }
}

/** Resolve a requested name to a confined regular file, or null. */
function resolveAsset(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null;
  if (name !== path.basename(name) || name.includes('\\') || name.includes('/') || name.includes('\0') ||
      name === '.' || name === '..') return null;
  const root = realRoot();
  if (!root) return null;
  try {
    const real = fs.realpathSync(path.join(root, name));
    if (path.dirname(real) !== root) return null;
    const st = fs.statSync(real);
    return st.isFile() ? { real, size: st.size } : null;
  } catch { return null; }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

/** -> { available, version, files:[{ name, size, sha256, type }] } */
function assetManifest() {
  const version = packageVersion();
  const root = realRoot();
  if (!root) return { available: false, version, files: [] };
  const files = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const a = resolveAsset(e.name);
    if (!a || a.size > MAX_ASSET_BYTES) continue;
    files.push({
      name: e.name, size: a.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(a.real)).digest('hex'),
      type: typeOf(e.name),
    });
  }
  files.sort((x, y) => (x.name < y.name ? -1 : 1));
  return { available: true, version, files };
}

/** -> { ok:true, name, size, type, sha256, data(base64) } | { ok:false, error } */
function readAsset(name) {
  const a = resolveAsset(name);
  if (!a) return { ok: false, error: 'not_found' };
  if (a.size > MAX_ASSET_BYTES) return { ok: false, error: 'too_large' };
  const buf = fs.readFileSync(a.real);
  return {
    ok: true, name, size: buf.length, type: typeOf(name),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    data: buf.toString('base64'),
  };
}

/**
 * Basenames of local stylesheet/script references in dist-web/index.html that the manifest
 * cannot serve (e.g. nested under assets/). ['index.html'] when the root or index.html is absent.
 */
function missingEntryFiles() {
  let html;
  try { html = fs.readFileSync(path.join(webRoot(), 'index.html'), 'utf8'); } catch { return ['index.html']; }
  const served = new Set(assetManifest().files.map((f) => f.name));
  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
    const h = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (h) refs.push(h[1]);
  }
  const missing = [];
  for (const ref of refs) {
    if (/^(https?:)?\/\//i.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
    const name = path.basename(ref.split(/[?#]/)[0]);
    if (name && !served.has(name) && !missing.includes(name)) missing.push(name);
  }
  return missing;
}

module.exports = {
  assetManifest, readAsset, missingEntryFiles, MAX_ASSET_BYTES,
  __test: { setRoot: (p) => { _rootOverride = p; } },
};
