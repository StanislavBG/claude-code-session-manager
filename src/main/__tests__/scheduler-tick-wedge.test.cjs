/**
 * scheduler-tick-wedge.test.cjs — tickQueue's serialized chain (tickTail) must
 * survive a tick body that never settles: the body is bounded by a watchdog,
 * the chain resets, and a late-resuming stale body is fenced off (no spawn, no
 * mutate). mutateTail is never reset.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-tick-wedge.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let originalClaudeBin;
let originalAutofix;
let originalWatchdog;
let scheduler;
let queueStore;
let auditLog;
let spawnMarker;

function auditKinds() {
  try {
    return fs.readFileSync(auditLog.auditLogPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);
  } catch { return []; }
}

beforeAll(() => {
  originalHome = process.env.HOME;
  originalClaudeBin = process.env.SM_CLAUDE_BIN;
  originalAutofix = process.env.SM_AUTOFIX_DISABLE;
  originalWatchdog = process.env.SM_TICK_WATCHDOG_MS;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tick-wedge-'));
  process.env.HOME = tmpHome;
  process.env.SM_AUTOFIX_DISABLE = '1';
  // Any spawn of the "claude" binary drops a marker file: proof spawnJob ran.
  spawnMarker = path.join(tmpHome, 'claude-spawned.marker');
  const stubPath = path.join(tmpHome, 'claude-stub.cjs');
  const body = `require('node:fs').appendFileSync(${JSON.stringify(spawnMarker)}, 'x');\n`
    + `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');\n`
    + 'process.exit(0);\n';
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  process.env.SM_CLAUDE_BIN = stubPath;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
  auditLog = require('../lib/auditLog.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  for (const [k, v] of [['SM_CLAUDE_BIN', originalClaudeBin], ['SM_AUTOFIX_DISABLE', originalAutofix], ['SM_TICK_WATCHDOG_MS', originalWatchdog]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('a never-settling tick body is declared wedged, the chain resets, the stale body is fenced, audit fires once', async () => {
  process.env.SM_TICK_WATCHDOG_MS = '150';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tick-wedge-project-'));
  const projDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'projects', 'sm-tick-wedge-fake-'));
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd })}\n`, 'utf8');
  const slug = `9003-tick-wedge-${process.pid}`;
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: [] }],
    config: {},
    paused: null,
  });

  // The first readMerged (the tick body's first await) hangs until released;
  // every later call delegates to the real reader.
  const realRead = queueStore.readMerged;
  let release;
  const hung = new Promise((r) => { release = r; });
  let calls = 0;
  queueStore.readMerged = function patched(...args) {
    calls += 1;
    if (calls === 1) return hung;
    return realRead.apply(this, args);
  };

  try {
    const wedgedResult = await scheduler.tickQueue();
    expect(wedgedResult).toMatchObject({ fired: false, reason: 'wedged' });
    expect(auditKinds().filter((k) => k === 'tick_wedged')).toHaveLength(1);

    // A second wedge in the same episode (no normal tick between) must not re-audit.
    calls = 0;
    const hung2 = new Promise(() => {});
    queueStore.readMerged = function patched2(...args) {
      calls += 1;
      if (calls === 1) return hung2;
      return realRead.apply(this, args);
    };
    const again = await scheduler.tickQueue();
    expect(again).toMatchObject({ reason: 'wedged' });
    expect(auditKinds().filter((k) => k === 'tick_wedged')).toHaveLength(1);

    // Next tick runs on a fresh chain (real reader, generous budget).
    queueStore.readMerged = realRead;
    process.env.SM_TICK_WATCHDOG_MS = '30000';
    // Launch gates this case controls, so the dispatch assertion below does not
    // depend on host state: the CPU load gate (loadavg1/cores > 0.85 -> 'load-deferred')
    // via tickQueue's bypassLoadGate, and the memory gate ('memory-deferred', reads
    // MemAvailable from /proc/meminfo) via a stubbed fs.readFileSync for that one path.
    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(file, ...rest) {
      if (file === '/proc/meminfo') return 'MemAvailable:   67108864 kB\n';
      return realReadFileSync.call(this, file, ...rest);
    };
    let fresh;
    try {
      fresh = await scheduler.tickQueue({ bypassLoadGate: true });
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    expect(fresh.reason).not.toBe('wedged');

    // Let the fresh tick's own spawn (if any) finish, then clear the marker.
    // The fresh tick must have dispatched: wait for the stub's marker, then for
    // the row to leave running/pending (spawnJob is fire-and-forget).
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = queueStore.readMergedSync().jobs.find((j) => j.slug === slug);
      if (fs.existsSync(spawnMarker) && (!row || (row.status !== 'running' && row.status !== 'pending'))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(spawnMarker)).toBe(true);
    fs.rmSync(spawnMarker, { force: true });

    // Late-resume the stale body with a state that WOULD dispatch a pending job.
    const before = queueStore.readMergedSync();
    const staleState = {
      ...before,
      jobs: [{ slug: `9004-tick-wedge-stale-${process.pid}`, title: 'y', cwd, status: 'pending', dependsOn: [] }],
      config: { ...(before.config || {}) },
    };
    release(staleState);
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(spawnMarker)).toBe(false);
  } finally {
    queueStore.readMerged = realRead;
  }
});

test('a slow-but-healthy tick under the budget is not flagged as wedged', async () => {
  process.env.SM_TICK_WATCHDOG_MS = '2000';
  const realRead = queueStore.readMerged;
  const before = auditKinds().filter((k) => k === 'tick_wedged').length;
  queueStore.readMerged = async function slow(...args) {
    await new Promise((r) => setTimeout(r, 100));
    return realRead.apply(this, args);
  };
  try {
    const r = await scheduler.tickQueue();
    expect(r?.reason).not.toBe('wedged');
    expect(auditKinds().filter((k) => k === 'tick_wedged').length).toBe(before);
  } finally {
    queueStore.readMerged = realRead;
  }
});
