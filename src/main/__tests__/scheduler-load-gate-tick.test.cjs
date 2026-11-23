/**
 * scheduler-load-gate-tick.test.cjs — the real tickQueue with an injected load
 * gate: high loadavg + idle CPU stands down and fires; high loadavg + busy CPU
 * returns 'load-deferred' and names the CPU figure in lastTick.detail.
 *
 * Deterministic by construction: launches go to an injected spawn recorder
 * (_setSpawnJobForTests) so no child job runs and no completion tick races the
 * next case; the memory gate reads a fixture (SM_MEMINFO_PATH); the load gate's
 * loadavg, CPU sample and clock are all injected.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-load-gate-tick.test.cjs
 */

'use strict';

import { test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');
const { settleScheduler } = require('../../../tests/helpers/schedulerSettle.cjs');

const PRD_BODY = '---\ntitle: Load gate PRD\ncreatedVia: scheduler-api\n---\n\nLoad gate PRD.\n';

let tmpHome;
let originalHome;
let originalWt;
let scheduler;
let createLoadGate;
let queueStore;
let holdGate;
let auditLogPath;
let originalMeminfo;
// Slugs the tick dispatched, in order; reset before every case.
let spawned = [];
// Fixed clock for gates whose test does not move time itself.
const FIXED_NOW = () => 42_000_000;

function makeProject(name) {
  const cwd = path.join(tmpHome, 'Projects', name);
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'fixture-epic', 'prds');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(prdsDir, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${name}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  return { cwd, prdsDir, queueFile: path.join(stateDir, 'queue.json') };
}

function queueOne(proj, slug) {
  fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: [{ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
  queueStore.bustCwdCache();
}

function gateWithCpu(busyFraction) {
  return createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction, iowaitFraction: 0, windowMs: 61_000 }) },
    now: FIXED_NOW,
  });
}

function readAuditKind(kind) {
  let lines;
  try {
    lines = fs.readFileSync(auditLogPath(), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

beforeAll(() => {
  originalHome = process.env.HOME;
  originalWt = process.env.SM_JOB_WORKTREE_DISABLE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-load-gate-tick-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  // Ample memory, no swap: the memory gate must never depend on the real host.
  originalMeminfo = process.env.SM_MEMINFO_PATH;
  const ample = path.join(tmpHome, 'meminfo-64gb');
  fs.writeFileSync(ample, 'MemAvailable:    67108864 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
  process.env.SM_MEMINFO_PATH = ample;
  scheduler = require('../scheduler.cjs');
  ({ createLoadGate } = require('../lib/scheduler/loadGate.cjs'));
  queueStore = require('../lib/scheduler/queueStore.cjs');
  holdGate = createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction: 0.95, iowaitFraction: 0, windowMs: 61_000 }) },
    now: FIXED_NOW,
  });
  ({ auditLogPath } = require('../lib/telemetry/auditLog.cjs'));
  // Pin the version so no tick execs a binary; the stub stays as a tripwire —
  // dispatch is injected, so ran-here.marker must never appear.
  process.env.SM_CLAUDE_VERSION = '2.0.0-test';
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
    require('fs').writeFileSync(require('path').join(process.cwd(), 'ran-here.marker'), 'yes');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
  scheduler._setSpawnJobForTests(async (job) => { spawned.push(job.slug); });
});

beforeEach(() => { spawned = []; });

afterEach(() => settleScheduler({ scheduler, holdGate, projectsDir: path.join(tmpHome, 'Projects') }));

afterAll(() => {
  scheduler._setSpawnJobForTests(null);
  if (originalMeminfo === undefined) delete process.env.SM_MEMINFO_PATH;
  else process.env.SM_MEMINFO_PATH = originalMeminfo;
  process.env.HOME = originalHome;
  if (originalWt === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalWt;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_BIN;
  delete process.env.SM_CLAUDE_VERSION;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Busy test first: it launches nothing.
test('high loadavg with a busy CPU defers and names the CPU figure', async () => {
  const proj = makeProject('busy-proj');
  queueOne(proj, `9201-busy-${process.pid}`);
  scheduler._setLoadGateForTests(gateWithCpu(0.91));
  const result = await scheduler.tickQueue();
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('load-deferred');
  const payload = scheduler.buildScheduleStatePayload({ config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null });
  expect(payload.lastTick.detail).toContain('CPU 91% busy over 61s');
  expect(spawned).toEqual([]);
  expect(fs.existsSync(path.join(proj.cwd, 'ran-here.marker'))).toBe(false);
}, 120_000);

test('high loadavg with an idle CPU stands down and fires the batch', async () => {
  const proj = makeProject('idle-proj');
  queueOne(proj, `9202-idle-${process.pid}`);
  scheduler._setLoadGateForTests(gateWithCpu(0.13));
  const result = await scheduler.tickQueue();
  expect(result.reason).not.toBe('load-deferred');
  expect(result.fired).toBe(true);
  expect(spawned).toEqual([`9202-idle-${process.pid}`]);
  const rows = readAuditKind('load_gate_stood_down');
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows[0].cpuBusy).toBe(0.13);
}, 120_000);

test('a hold that reaches the yield window launches exactly one of two rows, with one audit row and one toast', async () => {
  const proj = makeProject('yield-proj');
  const slugs = [`9203-yield-a-${process.pid}`, `9203-yield-b-${process.pid}`];
  for (const slug of slugs) fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: slugs.map((slug) => ({ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() })),
  }));
  queueStore.bustCwdCache();
  let t = 1_000_000;
  scheduler._setLoadGateForTests(createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction: 0.6, iowaitFraction: 0, windowMs: 61_000 }) },
    now: () => t,
    yieldAfterMs: 5 * 60_000,
    holdCreditCapMs: 10 * 60_000,
  }));
  const sent = [];
  scheduler.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isCrashed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
  const first = await scheduler.tickQueue();
  expect(first.reason).toBe('load-deferred');
  t += 6 * 60_000;
  const second = await scheduler.tickQueue();
  expect(second.fired).toBe(true);
  expect(second.count).toBe(1);
  const rows = readAuditKind('load_gate_yielded');
  expect(rows.length).toBe(1);
  expect(rows[0].stillHeld.length).toBe(1);
  expect(sent.filter((m) => m.channel === 'schedule:stall').length).toBe(1);
  // Exactly one of the two rows was dispatched; the other stays held.
  expect(spawned.length).toBe(1);
  expect(slugs).toContain(spawned[0]);
  expect(rows[0].launched).toBe(spawned[0]);
  expect(rows[0].stillHeld).toEqual(slugs.filter((s) => s !== spawned[0]));
}, 120_000);

test('a saturated hold at the yield window launches nothing, with one audit row and one toast', async () => {
  const proj = makeProject('sat-proj');
  const slugs = [`9206-sat-a-${process.pid}`, `9206-sat-b-${process.pid}`];
  for (const slug of slugs) fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: slugs.map((slug) => ({ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() })),
  }));
  queueStore.bustCwdCache();
  let t = 9_000_000;
  scheduler._setLoadGateForTests(createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction: 0.95, iowaitFraction: 0, windowMs: 61_000 }) },
    now: () => t,
    yieldAfterMs: 5 * 60_000,
    holdCreditCapMs: 10 * 60_000,
  }));
  const sent = [];
  scheduler.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isCrashed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
  const before = readAuditKind('load_gate_escalated').length;
  const first = await scheduler.tickQueue();
  expect(first.reason).toBe('load-deferred');
  t += 6 * 60_000;
  const second = await scheduler.tickQueue();
  expect(second.reason).toBe('load-deferred');
  expect(second.fired).toBe(false);
  const queue = JSON.parse(fs.readFileSync(proj.queueFile, 'utf8'));
  expect(queue.jobs.filter((j) => j.status === 'pending').length).toBe(2);
  expect(spawned).toEqual([]);
  const rows = readAuditKind('load_gate_escalated').slice(before);
  expect(rows.length).toBe(1);
  expect(rows[0].held).toEqual(expect.arrayContaining(slugs));
  expect(rows[0].cpuBusy).toBe(0.95);
  expect(sent.filter((m) => m.channel === 'schedule:stall').length).toBe(1);
  expect(fs.existsSync(path.join(proj.cwd, 'ran-here.marker'))).toBe(false);
}, 120_000);

function readDispatchStamps() {
  const f = path.join(tmpHome, '.claude', 'session-manager', 'scheduler-machine.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).lastDispatchAtByCwd || {}; } catch { return {}; }
}

test('endHold is called on a drained tick and a paused tick, not on a memory-deferred tick, and on a launch', async () => {
  const proj = makeProject('endhold-proj');
  const gate = gateWithCpu(0.91);
  const spy = vi.spyOn(gate, 'endHold');
  scheduler._setLoadGateForTests(gate);

  // drained
  const drained = await scheduler.tickQueue();
  expect(drained.fired).toBe(false);
  expect(spy).toHaveBeenCalledTimes(1);

  // paused
  await scheduler.setPaused('manual', null);
  try {
    spy.mockClear();
    const paused = await scheduler.tickQueue();
    expect(paused.reason).toBe('paused');
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    await scheduler.clearPause('manual');
  }
  expect((await queueStore.readMerged()).paused).toBeFalsy();

  // memory-deferred: work is waiting, so the hold must survive
  const slug = `9204-mem-${process.pid}`;
  queueOne(proj, slug);
  const fixture = path.join(tmpHome, 'meminfo-1gb');
  fs.writeFileSync(fixture, 'MemAvailable:    1048576 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
  const prev = process.env.SM_MEMINFO_PATH;
  process.env.SM_MEMINFO_PATH = fixture;
  try {
    spy.mockClear();
    const deferred = await scheduler.tickQueue();
    expect(deferred.reason).toBe('memory-deferred');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    if (prev === undefined) delete process.env.SM_MEMINFO_PATH;
    else process.env.SM_MEMINFO_PATH = prev;
  }

  // launch (bypass the busy gate, as Run now does)
  spy.mockClear();
  const launched = await scheduler.tickQueue({ bypassLoadGate: true });
  expect(launched.fired).toBe(true);
  expect(spawned).toEqual([slug]);
  expect(spy).toHaveBeenCalledTimes(1);
}, 120_000);

test('a yield stamps lastDispatchAtByCwd only for the launched row\'s project', async () => {
  const a = makeProject('stamp-a');
  const b = makeProject('stamp-b');
  const slugA = `9205-stamp-a-${process.pid}`;
  const slugB = `9205-stamp-b-${process.pid}`;
  queueOne(a, slugA);
  queueOne(b, slugB);
  let t = 5_000_000;
  scheduler._setLoadGateForTests(createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction: 0.6, iowaitFraction: 0, windowMs: 61_000 }) },
    now: () => t,
    yieldAfterMs: 5 * 60_000,
    holdCreditCapMs: 10 * 60_000,
  }));
  const first = await scheduler.tickQueue();
  expect(first.reason).toBe('load-deferred');
  expect(readDispatchStamps()[a.cwd]).toBeUndefined();
  expect(readDispatchStamps()[b.cwd]).toBeUndefined();
  t += 6 * 60_000;
  const second = await scheduler.tickQueue();
  expect(second.fired).toBe(true);
  expect(second.count).toBe(1);
  const stamps = readDispatchStamps();
  const stamped = [a.cwd, b.cwd].filter((c) => stamps[c]);
  expect(stamped.length).toBe(1);
  expect(spawned.length).toBe(1);
  expect(stamped[0]).toBe(spawned[0] === slugA ? a.cwd : b.cwd);
}, 120_000);
