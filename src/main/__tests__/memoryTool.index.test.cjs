'use strict';

import { test, beforeAll, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memtool-index-')));
const origHome = process.env.HOME;
process.env.HOME = tmpHome; // before memoryTool/config load: allowedRoots = homedir()

const WS = 'idx-ws';
let tool;
let dir;
const idx = () => path.join(dir, 'MEMORY.md');
const readIdx = () => fs.readFileSync(idx(), 'utf8');

beforeAll(() => {
  tool = require('../memoryTool.cjs');
  dir = path.join(tmpHome, '.claude', 'projects', WS, 'memory');
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('create adds exactly one index line and is idempotent against an existing line', async () => {
  const r = await tool.create({ workspace: WS, name: 'alpha.md', description: 'first note' });
  assert.equal(r.ok, true);
  assert.equal(readIdx(), '- [alpha](alpha.md) — first note\n');

  // Pre-existing line for a not-yet-created file: create must not duplicate it.
  fs.appendFileSync(idx(), '- [beta](beta.md) — kept\n');
  const r2 = await tool.create({ workspace: WS, name: 'beta.md', description: 'other' });
  assert.equal(r2.ok, true);
  assert.equal(readIdx().split('\n').filter((l) => l.includes('(beta.md)')).length, 1);
});

test('creating MEMORY.md itself never adds an index line', async () => {
  const d2 = 'idx-ws-2';
  const r = await tool.create({ workspace: d2, name: 'MEMORY.md', description: 'x' });
  // The slug regex is lowercase-only, so MEMORY.md is rejected outright; the
  // name === 'MEMORY.md' guard in create() is defense in depth.
  assert.equal(r.ok, false);
  const p = path.join(tmpHome, '.claude', 'projects', d2, 'memory', 'MEMORY.md');
  assert.ok(!fs.existsSync(p));
});

test('delete removes the line and leaves others byte-identical', async () => {
  await tool.create({ workspace: WS, name: 'gamma.md', description: 'g' });
  const before = readIdx();
  const keep = before.split('\n').filter((l) => !l.includes('(gamma.md)')).join('\n');
  const d = await tool.deleteEntry({ workspace: WS, name: 'gamma.md' });
  assert.deepEqual(d, { ok: true, error: null });
  assert.equal(readIdx(), keep);
  assert.ok(!fs.existsSync(path.join(dir, 'gamma.md')));
});

test('stale().index reports orphans and dangling lines', async () => {
  await tool.write({ workspace: WS, name: 'orphan.md', content: 'no index line' });
  fs.rmSync(path.join(dir, 'alpha.md')); // out-of-band removal -> dangling
  const s = await tool.stale({ workspace: WS });
  assert.equal(s.error, null);
  assert.ok(s.index.orphans.includes('orphan.md'));
  assert.ok(s.index.dangling.includes('alpha.md'));
  assert.equal(s.index.maxLines, 200);
});
