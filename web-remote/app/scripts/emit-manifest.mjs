// Emits dist/manifest.json per the Bilko host-contract (§Manifest). Node built-ins only.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function git(cmd, fallback) {
  try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return fallback; }
}

const files = walk(dist);
let sizeBytesGz = 0;
for (const f of files) sizeBytesGz += gzipSync(readFileSync(f)).length;

const manifest = {
  schemaVersion: 1,
  slug: 'session-manager',
  version: pkg.version,
  builtAt: new Date().toISOString(),
  gitSha: git('git rev-parse --short HEAD', '0000000'),
  gitBranch: git('git rev-parse --abbrev-ref HEAD', 'main'),
  hostKit: { version: '0.0.0' },
  golden: { path: '/projects/session-manager/', expect: 'Session Manager' },
  health: {},
  bundle: { sizeBytesGz, fileCount: files.length },
};

writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest.json: ${(sizeBytesGz / 1024).toFixed(1)} KB gz across ${files.length} files`);
