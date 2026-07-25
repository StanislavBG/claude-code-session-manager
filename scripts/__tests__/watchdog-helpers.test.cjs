'use strict';

// Run: timeout 120 node --test scripts/__tests__/watchdog-helpers.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  heartbeatFresh,
  readLastHeartbeat,
  localDateStr,
  maybeFinalizeHistory,
  tryAcquireLock,
  releaseLock,
} = require('../lib/watchdogHelpers.cjs');

function tmpFile() {
  return path.join(os.tmpdir(), `watchdog-test-${process.pid}-${Math.floor(Math.random() * 1e9)}.log`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-history-test-'));
}

function writeLines(p, lines) {
  fs.writeFileSync(p, lines.join('\n') + '\n');
}

test('fresh ts (just now) → true', () => {
  const p = tmpFile();
  try {
    writeLines(p, [JSON.stringify({ ts: Date.now(), counts: {}, paused: null })]);
    assert.equal(heartbeatFresh(p, 180_000), true);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('stale ts (10 min old) → false', () => {
  const p = tmpFile();
  try {
    const staleTs = Date.now() - 10 * 60 * 1000;
    writeLines(p, [JSON.stringify({ ts: staleTs, counts: {}, paused: null })]);
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('missing file → false', () => {
  const p = path.join(os.tmpdir(), 'watchdog-test-nonexistent-999999.log');
  assert.equal(heartbeatFresh(p, 180_000), false);
});

test('garbage last line → false', () => {
  const p = tmpFile();
  try {
    writeLines(p, ['not json at all!!!']);
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('last non-empty line wins (fresh after stale)', () => {
  const p = tmpFile();
  try {
    const staleTs = Date.now() - 10 * 60 * 1000;
    writeLines(p, [
      JSON.stringify({ ts: staleTs }),
      JSON.stringify({ ts: Date.now() }),
    ]);
    assert.equal(heartbeatFresh(p, 180_000), true);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('empty file → false', () => {
  const p = tmpFile();
  try {
    fs.writeFileSync(p, '');
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('JSON line without ts field → false', () => {
  const p = tmpFile();
  try {
    writeLines(p, [JSON.stringify({ counts: {}, paused: null })]);
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

// ── readLastHeartbeat ─────────────────────────────────────────────────────────

test('readLastHeartbeat: returns full parsed object including pid', () => {
  const p = tmpFile();
  try {
    const entry = { ts: Date.now(), pid: 12345, counts: {}, paused: null };
    writeLines(p, [JSON.stringify(entry)]);
    const result = readLastHeartbeat(p);
    assert.equal(result.ts, entry.ts);
    assert.equal(result.pid, 12345);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('readLastHeartbeat: returns null for missing file', () => {
  const p = path.join(os.tmpdir(), 'watchdog-helpers-test-nonexistent-999999.log');
  assert.equal(readLastHeartbeat(p), null);
});

test('readLastHeartbeat: returns null for empty file', () => {
  const p = tmpFile();
  try {
    fs.writeFileSync(p, '');
    assert.equal(readLastHeartbeat(p), null);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('readLastHeartbeat: returns object without pid for legacy entry', () => {
  const p = tmpFile();
  try {
    const staleTs = Date.now() - 10 * 60 * 1000;
    writeLines(p, [JSON.stringify({ ts: staleTs, counts: {}, paused: null })]);
    const result = readLastHeartbeat(p);
    assert.ok(result !== null);
    assert.equal(result.ts, staleTs);
    assert.equal(result.pid, undefined);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

// ── maybeFinalizeHistory: stamp gate ─────────────────────────────────────────

test('maybeFinalizeHistory: same-day stamp → skip in O(1), finalizeFn never called', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    fs.writeFileSync(stampPath, localDateStr(), 'utf8');
    let called = false;
    const result = await maybeFinalizeHistory({
      stampPath,
      lockPath,
      finalizeFn: async () => { called = true; return { finalizedDates: [], partial: false }; },
    });
    assert.equal(called, false);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'already-finalized-today');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maybeFinalizeHistory: new day (stale/missing stamp) → runs and stamps today', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    fs.writeFileSync(stampPath, '2000-01-01', 'utf8');
    let called = false;
    const result = await maybeFinalizeHistory({
      stampPath,
      lockPath,
      finalizeFn: async (opts) => { called = true; assert.equal(opts.budgetMs, 60_000); return { finalizedDates: ['2000-01-02'], partial: false }; },
    });
    assert.equal(called, true);
    assert.equal(result.ran, true);
    assert.equal(result.reason, 'finalized');
    assert.equal(fs.readFileSync(stampPath, 'utf8').trim(), localDateStr());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maybeFinalizeHistory: missing stamp file → treated as new day, runs', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    const result = await maybeFinalizeHistory({
      stampPath,
      lockPath,
      finalizeFn: async () => ({ finalizedDates: [], partial: false }),
    });
    assert.equal(result.ran, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── maybeFinalizeHistory: lock contention ────────────────────────────────────

test('maybeFinalizeHistory: lock already held (fresh) by another caller → skip silently', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    // Simulate a concurrent holder (e.g. the in-app Electron boot pass).
    assert.equal(tryAcquireLock(lockPath, 10 * 60 * 1000), true);
    let called = false;
    const result = await maybeFinalizeHistory({
      stampPath,
      lockPath,
      finalizeFn: async () => { called = true; return { finalizedDates: [], partial: false }; },
    });
    assert.equal(called, false);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'lock-contended');
    // The other holder's lock must be untouched by the loser.
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    releaseLock(path.join(dir, 'history-rollup.lock'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maybeFinalizeHistory: stale lock (older than staleLockMs) is reclaimed and runs', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    fs.writeFileSync(lockPath, '99999', 'utf8');
    const staleTime = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    let called = false;
    const result = await maybeFinalizeHistory({
      stampPath,
      lockPath,
      staleLockMs: 10 * 60 * 1000,
      finalizeFn: async () => { called = true; return { finalizedDates: [], partial: false }; },
    });
    assert.equal(called, true);
    assert.equal(result.ran, true);
    // Lock is released after the run.
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maybeFinalizeHistory: releases the lock even when finalizeFn throws', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    await assert.rejects(() => maybeFinalizeHistory({
      stampPath,
      lockPath,
      finalizeFn: async () => { throw new Error('boom'); },
    }));
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── maybeFinalizeHistory: budget-partial ─────────────────────────────────────

test('maybeFinalizeHistory: partial finalize (budget exceeded) does NOT stamp the day complete', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    const result = await maybeFinalizeHistory({
      stampPath,
      lockPath,
      finalizeFn: async () => ({ finalizedDates: [], partial: true }),
    });
    assert.equal(result.ran, true);
    assert.equal(result.reason, 'partial');
    assert.equal(fs.existsSync(stampPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── maybeFinalizeHistory: dry run ────────────────────────────────────────────

test('maybeFinalizeHistory: dryRun computes without stamping or requiring a write', async () => {
  const dir = tmpDir();
  try {
    const stampPath = path.join(dir, 'history-rollup.stamp');
    const lockPath = path.join(dir, 'history-rollup.lock');
    let seenDryRun;
    const result = await maybeFinalizeHistory({
      stampPath,
      lockPath,
      dryRun: true,
      finalizeFn: async (opts) => { seenDryRun = opts.dryRun; return { finalizedDates: ['2026-07-01'], partial: false }; },
    });
    assert.equal(seenDryRun, true);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'dry-run');
    assert.deepEqual(result.finalizedDates, ['2026-07-01']);
    assert.equal(fs.existsSync(stampPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
