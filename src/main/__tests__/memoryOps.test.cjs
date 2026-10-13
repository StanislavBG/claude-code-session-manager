'use strict';

import { test, beforeAll, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memops-')));
const origHome = process.env.HOME;
process.env.HOME = tmpHome; // before config loads: allowedRoots = homedir()

let ops;
let dir;
const idx = () => path.join(dir, 'MEMORY.md');

beforeAll(() => {
  ops = require('../lib/memoryOps.cjs');
  dir = path.join(tmpHome, '.claude', 'projects', 'ops-ws', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'alpha.md'), '---\nname: alpha\ndescription: first note\n---\n\nbody\n');
  fs.writeFileSync(path.join(dir, 'beta.md'), 'no frontmatter\n');
  fs.writeFileSync(idx(), '- [alpha](alpha.md) — first note\n- [beta](beta.md)\n');
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('verify bumps mtime without changing content', async () => {
  const p = path.join(dir, 'alpha.md');
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(p, old, old);
  const before = fs.readFileSync(p);
  const r = await ops.verify(dir, 'alpha.md');
  assert.deepEqual(r, { ok: true, error: null });
  assert.ok(fs.statSync(p).mtimeMs > old.getTime() + 1000);
  assert.ok(fs.readFileSync(p).equals(before));
  const miss = await ops.verify(dir, 'nope.md');
  assert.equal(miss.ok, false);
  assert.ok(miss.error);
});

test('archive -> listArchived -> restore round-trips incl. index line', async () => {
  assert.deepEqual(await ops.listArchived(dir), { names: [], error: null });
  assert.deepEqual(await ops.archive(dir, 'alpha.md'), { ok: true, error: null });
  assert.ok(!fs.existsSync(path.join(dir, 'alpha.md')));
  assert.ok(fs.existsSync(path.join(dir, '.archive', 'alpha.md')));
  assert.equal(fs.readFileSync(idx(), 'utf8'), '- [beta](beta.md)\n');
  assert.deepEqual(await ops.listArchived(dir), { names: ['alpha.md'], error: null });

  assert.deepEqual(await ops.restore(dir, 'alpha.md'), { ok: true, error: null });
  assert.ok(fs.existsSync(path.join(dir, 'alpha.md')));
  assert.deepEqual(await ops.listArchived(dir), { names: [], error: null });
  assert.equal(
    fs.readFileSync(idx(), 'utf8'),
    '- [beta](beta.md)\n- [alpha](alpha.md) — first note\n',
  );
});

test('archive of MEMORY.md and bad names are refused', async () => {
  const r = await ops.archive(dir, 'MEMORY.md');
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(idx()));
  assert.equal((await ops.archive(dir, '../x.md')).ok, false);
});

test('restore over an existing file and archive over an archived copy are refused', async () => {
  await ops.archive(dir, 'beta.md');
  fs.writeFileSync(path.join(dir, 'beta.md'), 'new beta\n');
  const r = await ops.restore(dir, 'beta.md');
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'beta.md'), 'utf8'), 'new beta\n');
  assert.ok(fs.existsSync(path.join(dir, '.archive', 'beta.md')));
  const a = await ops.archive(dir, 'beta.md');
  assert.equal(a.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'beta.md'), 'utf8'), 'new beta\n');
});
