/**
 * staleTmpSweep.test.cjs — dead-writer tmp sweep + runs-archive age prune.
 * Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/staleTmpSweep.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sweepStaleTmp, pruneRunsArchive } = require('../staleTmpSweep.cjs');

const DAY = 86400000;
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-tmp-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function mk(name, ageMs, now, body = 'x'.repeat(100)) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  const t = (now - ageMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

test('sweepStaleTmp removes old dead-pid tmp, keeps live/fresh/.bak', () => {
  const now = Date.now();
  const dead = mk('queue.json.tmp-111-abc', 2 * 3600000, now);
  const dead2 = mk('.max-allocated-group.tmp-111-x', 2 * 3600000, now);
  const live = mk('queue.json.tmp-222-abc', 2 * 3600000, now);
  const fresh = mk('queue.json.tmp-111-new', 1000, now);
  const bak = mk('queue.json.bak-1', 10 * DAY, now);
  const r = sweepStaleTmp(dir, { now, isPidAlive: (pid) => pid === 222 });
  expect(fs.existsSync(dead)).toBe(false);
  expect(fs.existsSync(dead2)).toBe(false);
  expect(fs.existsSync(live)).toBe(true);
  expect(fs.existsSync(fresh)).toBe(true);
  expect(fs.existsSync(bak)).toBe(true);
  expect(r.removedFiles).toBe(2);
  expect(r.freedBytes).toBe(200);
  expect(r.backups).toEqual(['queue.json.bak-1']);
});

test('pruneRunsArchive removes 40-day entry, keeps 5-day', () => {
  const now = Date.now();
  const old = mk('old.tgz', 40 * DAY, now);
  const recent = mk('recent.tgz', 5 * DAY, now);
  const r = pruneRunsArchive(dir, { now });
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(recent)).toBe(true);
  expect(r.removedFiles).toBe(1);
});

test('missing dirs are a no-op', () => {
  expect(sweepStaleTmp(path.join(dir, 'nope')).removedFiles).toBe(0);
  expect(pruneRunsArchive(path.join(dir, 'nope')).removedFiles).toBe(0);
});
