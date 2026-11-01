/**
 * scheduler-load-gate-tick.test.cjs — the real tickQueue with an injected load
 * gate: high loadavg + idle CPU stands down and fires; high loadavg + busy CPU
 * returns 'load-deferred' and names the CPU figure in lastTick.detail.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-load-gate-tick.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let originalWt;
let scheduler;
let createLoadGate;
let auditLogPath;

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
  fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), 'Load gate PRD.', 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: [{ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
}

function gateWithCpu(busyFraction) {
  return createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction, iowaitFraction: 0, windowMs: 61_000 }) },
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
  scheduler = require('../scheduler.cjs');
  ({ createLoadGate } = require('../lib/scheduler/loadGate.cjs'));
  ({ auditLogPath } = require('../lib/telemetry/auditLog.cjs'));
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
    require('fs').writeFileSync(require('path').join(process.cwd(), 'ran-here.marker'), 'yes');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
});

function anyRunning() {
  try {
    const projects = path.join(tmpHome, 'Projects');
    for (const name of fs.readdirSync(projects)) {
      const qf = path.join(projects, name, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
      try {
        const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
        if ((q.jobs || []).some((j) => j.status === 'running')) return true;
      } catch { /* missing or mid-write */ }
    }
  } catch { /* no projects dir */ }
  return false;
}

afterAll(async () => {
  // A stub job may still be finalizing; removing HOME under it prints ENOENT noise.
  for (let i = 0; i < 100 && anyRunning(); i += 1) await new Promise((r) => setTimeout(r, 50));
  process.env.HOME = originalHome;
  if (originalWt === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalWt;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_BIN;
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
  expect(fs.existsSync(path.join(proj.cwd, 'ran-here.marker'))).toBe(false);
  // Drop the held row so the next test's tick launches only its own project.
  fs.writeFileSync(proj.queueFile, JSON.stringify({ jobs: [] }));
}, 120_000);

test('high loadavg with an idle CPU stands down and fires the batch', async () => {
  const proj = makeProject('idle-proj');
  queueOne(proj, `9202-idle-${process.pid}`);
  scheduler._setLoadGateForTests(gateWithCpu(0.13));
  const result = await scheduler.tickQueue();
  expect(result.reason).not.toBe('load-deferred');
  expect(result.fired).toBe(true);
  const rows = readAuditKind('load_gate_stood_down');
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows[0].cpuBusy).toBe(0.13);
}, 120_000);

test('a hold that reaches the yield window launches exactly one of two rows, with one audit row and one toast', async () => {
  const proj = makeProject('yield-proj');
  const slugs = [`9203-yield-a-${process.pid}`, `9203-yield-b-${process.pid}`];
  for (const slug of slugs) fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), 'Load gate PRD.', 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: slugs.map((slug) => ({ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() })),
  }));
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
  // spawnJob is fire-and-forget: wait for the launched row to leave 'pending'.
  let pending = 2;
  for (let i = 0; i < 50 && pending > 1; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const queue = JSON.parse(fs.readFileSync(proj.queueFile, 'utf8'));
    pending = queue.jobs.filter((j) => j.status === 'pending').length;
  }
  expect(pending).toBe(1);
  scheduler.attachWindow(null);
}, 120_000);

test('a saturated hold at the yield window launches nothing, with one audit row and one toast', async () => {
  const proj = makeProject('sat-proj');
  const slugs = [`9206-sat-a-${process.pid}`, `9206-sat-b-${process.pid}`];
  for (const slug of slugs) fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), 'Load gate PRD.', 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: slugs.map((slug) => ({ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() })),
  }));
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
  const rows = readAuditKind('load_gate_escalated').slice(before);
  expect(rows.length).toBe(1);
  expect(rows[0].held).toEqual(expect.arrayContaining(slugs));
  expect(rows[0].cpuBusy).toBe(0.95);
  expect(sent.filter((m) => m.channel === 'schedule:stall').length).toBe(1);
  expect(fs.existsSync(path.join(proj.cwd, 'ran-here.marker'))).toBe(false);
  scheduler.attachWindow(null);
  fs.writeFileSync(proj.queueFile, JSON.stringify({ jobs: [] }));
}, 120_000);

function readDispatchStamps() {
  const f = path.join(tmpHome, '.claude', 'session-manager', 'scheduler-machine.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).lastDispatchAtByCwd || {}; } catch { return {}; }
}

test('endHold is called on a drained tick and a paused tick, not on a memory-deferred tick, and on a launch', async () => {
  const proj = makeProject('endhold-proj');
  // Earlier tests left pending/finished rows in other projects; start from empty queues.
  for (const name of fs.readdirSync(path.join(tmpHome, 'Projects'))) {
    const qf = path.join(tmpHome, 'Projects', name, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
    if (fs.existsSync(qf)) fs.writeFileSync(qf, JSON.stringify({ jobs: [] }));
  }
  const gate = gateWithCpu(0.91);
  const spy = vi.spyOn(gate, 'endHold');
  scheduler._setLoadGateForTests(gate);

  // drained
  const drained = await scheduler.tickQueue();
  expect(drained.fired).toBe(false);
  expect(spy).toHaveBeenCalledTimes(1);

  // paused
  const queueStore = require('../lib/scheduler/queueStore.cjs');
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
  expect(spy).toHaveBeenCalledTimes(1);
  fs.writeFileSync(proj.queueFile, JSON.stringify({ jobs: [] }));
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
}, 120_000);
