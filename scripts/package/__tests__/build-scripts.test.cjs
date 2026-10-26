
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Resolve npm-run indirection so prepublishOnly -> build is followed.
function expand(cmd, seen = new Set()) {
  let out = cmd;
  for (const m of cmd.matchAll(/npm run ([\w:-]+)/g)) {
    if (seen.has(m[1]) || !pkg.scripts[m[1]]) continue;
    seen.add(m[1]);
    out += ' && ' + expand(pkg.scripts[m[1]], seen);
  }
  return out;
}

test('build runs both renderer targets', () => {
  assert.match(pkg.scripts.build, /vite build(?! --config)/);
  assert.match(pkg.scripts.build, /vite build --config vite\.web\.config\.ts/);
});

test('prepublishOnly writes build info first and builds the web target', () => {
  const s = pkg.scripts.prepublishOnly;
  assert.ok(s.startsWith('node scripts/write-build-info.cjs'));
  assert.match(expand(s), /vite build --config vite\.web\.config\.ts/);
});

test('every dist* entry in files is the outDir of a vite config the scripts run', () => {
  const run = expand(pkg.scripts.prepublishOnly) + ' ' + expand(pkg.scripts.build);
  const configs = ['vite.config.ts'];
  for (const m of run.matchAll(/--config\s+(\S+)/g)) configs.push(m[1]);
  const outDirs = configs.map((c) => {
    const src = fs.readFileSync(path.join(root, c), 'utf8');
    const m = src.match(/outDir:\s*path\.resolve\(__dirname,\s*'([^']+)'\)/);
    assert.ok(m, `no outDir in ${c}`);
    return m[1];
  });
  const distEntries = pkg.files.filter((f) => f.startsWith('dist'));
  assert.ok(distEntries.length > 0);
  for (const e of distEntries) {
    const top = e.split('/')[0];
    assert.ok(outDirs.includes(top), `${e} is not produced by any run vite config (${outDirs})`);
  }
});
