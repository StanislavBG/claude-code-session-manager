/**
 * scheduler-auto-dispatch-hold-audit.test.cjs — tickBody records each
 * auto-dispatch hold in audit-log.jsonl: one auto_dispatch_hold_started when it
 * engages, one auto_dispatch_hold_ended when it lifts, keyed by
 * utilizationHold.holdIdentityKey (percent changes and reset jitter write
 * nothing). The open hold survives a restart via scheduler-state.json.
 * 2026-11-24: the heartbeat log keeps ~18-37 h, shorter than a weekly hold.
 *
 * Harness: scheduler-auto-dispatch-hold.test.cjs (temp HOME, spawn recorder).
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-auto-dispatch-hold-audit.test.cjs
 */
'use strict';

import { test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRD_BODY = '---\ntitle: Hold PRD\ncreatedVia: scheduler-api\n---\n\nHold PRD.\n';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;

let tmpHome;
let originalHome;
let originalMeminfo;
let scheduler;
let billing;
let queueStore;
let schedulerPaths;
let auditLog;
let originalFetchUsage;
let spawned = [];
let seq = 0;
let auditMark = 0;

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

function queueOne() {
  seq += 1;
  const proj = makeProject(`hold-audit-proj-${seq}`);
  const slug = `9302-hold-audit-${process.pid}-${seq}`;
  fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: [{ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
  queueStore.bustCwdCache();
  return slug;
}

/** A reset time on an exact minute (±0.5 s never crosses holdIdentityKey rounding); callers pass > 7 days so the pro-rated threshold stays at the 90 base. */
function minuteReset(offsetMs) { return Math.round((Date.now() + offsetMs) / MINUTE) * MINUTE; }

function weeklyAt(pct, resetMs, sessionPct = 10) {
  const session = { kind: 'session', percent: sessionPct, resets_at: new Date(Date.now() + 2 * HOUR).toISOString(), scope: null };
  const limits = [session, { kind: 'weekly_all', percent: pct, resets_at: new Date(resetMs).toISOString(), scope: null }];
  return {
    kind: 'ok',
    data: { usage: { five_hour: { utilization: session.percent, resets_at: session.resets_at }, limits } },
  };
}

async function reading(pct, resetMs, sessionPct = 10) {
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => weeklyAt(pct, resetMs, sessionPct);
  await scheduler.refreshNextReset();
}

function auditLines() {
  const p = schedulerPaths.auditLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Hold audit events appended since the current test began. */
function holdEvents() {
  return auditLines().slice(auditMark).filter((e) => e.kind === 'auto_dispatch_hold_started' || e.kind === 'auto_dispatch_hold_ended');
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-auto-hold-audit-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  process.env.SM_CLAUDE_VERSION = '2.0.0-test';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  originalMeminfo = process.env.SM_MEMINFO_PATH;
  const ample = path.join(tmpHome, 'meminfo-64gb');
  fs.writeFileSync(ample, 'MemAvailable:    67108864 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
  process.env.SM_MEMINFO_PATH = ample;
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
  auditLog = require('../lib/telemetry/auditLog.cjs');
  originalFetchUsage = billing.fetchUsage;
  scheduler._setSpawnJobForTests(async (job) => { spawned.push(job.slug); });
});

beforeEach(async () => {
  spawned = [];
  await scheduler._mutateForTests((s) => { s.config = { ...(s.config || {}), firePolicy: 'when-available', utilizationThreshold: 90 }; });
  // Close any hold a previous test left open, then mark the log.
  await reading(10, minuteReset(7 * DAY + HOUR));
  await scheduler.tickQueue();
  expect(scheduler._getOpenAutoDispatchHoldForTests()).toBeNull();
  auditMark = auditLines().length;
});

afterEach(() => {
  billing.fetchUsage = originalFetchUsage;
  vi.restoreAllMocks();
});

afterAll(() => {
  scheduler._setSpawnJobForTests(null);
  billing.fetchUsage = originalFetchUsage;
  if (originalMeminfo === undefined) delete process.env.SM_MEMINFO_PATH;
  else process.env.SM_MEMINFO_PATH = originalMeminfo;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_VERSION;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('ac-1: the first held tick appends exactly one started event with the full field set', async () => {
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(96, reset);
  queueOne();
  const r = await scheduler.tickQueue();
  expect(r.reason).toBe('utilization-held');
  const ev = holdEvents();
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({
    kind: 'auto_dispatch_hold_started',
    reason: 'utilization-held',
    window: 'weekly_all',
    percent: 96,
    threshold: 90,
    resetsAt: new Date(reset).toISOString(),
    holdKey: `utilization-held|weekly_all|${new Date(reset).toISOString()}`,
  });
  expect(ev[0].pending).toBeGreaterThanOrEqual(1);
  expect(typeof ev[0].version).toBe('string');
  expect(spawned).toEqual([]);
});

test('ac-2: same holdKey with rising percent and ±0.5 s reset jitter appends nothing; maxPercent/heldTicks track', async () => {
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(92, reset);
  queueOne();
  await scheduler.tickQueue();
  await reading(97, reset + 500);
  await scheduler.tickQueue();
  await reading(94, reset - 500);
  await scheduler.tickQueue();
  // A human tick under the same hold keeps it open and writes nothing.
  await scheduler.runDueJobs({ bypassLoadGate: true, human: true });
  const ev = holdEvents();
  expect(ev.map((e) => e.kind)).toEqual(['auto_dispatch_hold_started']);
  const open = scheduler._getOpenAutoDispatchHoldForTests();
  expect(open).toMatchObject({ maxPercent: 97, heldTicks: 4 });
});

test('ac-3: no hold appends one ended event; a different holdKey ends the old one and starts its own', async () => {
  const resetA = minuteReset(7 * DAY + HOUR);
  const resetB = minuteReset(7 * DAY + 2 * HOUR);
  await reading(95, resetA);
  queueOne();
  await scheduler.tickQueue();
  await reading(98, resetA);
  await scheduler.tickQueue();
  await reading(96, resetB);
  await scheduler.tickQueue();
  let ev = holdEvents();
  expect(ev.map((e) => e.kind)).toEqual(['auto_dispatch_hold_started', 'auto_dispatch_hold_ended', 'auto_dispatch_hold_started']);
  expect(ev[1]).toMatchObject({
    reason: 'utilization-held',
    window: 'weekly_all',
    threshold: 90,
    resetsAt: new Date(resetA).toISOString(),
    holdKey: ev[0].holdKey,
    maxPercent: 98,
    heldTicks: 2,
  });
  expect(Date.parse(ev[1].startedAt)).toBeLessThanOrEqual(Date.parse(ev[1].endedAt));
  expect(ev[1].endedAcrossRestart).toBeUndefined();
  expect(ev[2].holdKey).toBe(`utilization-held|weekly_all|${new Date(resetB).toISOString()}`);

  await reading(10, resetB);
  await scheduler.tickQueue();
  ev = holdEvents();
  expect(ev).toHaveLength(4);
  expect(ev[3]).toMatchObject({ kind: 'auto_dispatch_hold_ended', holdKey: ev[2].holdKey, maxPercent: 96, heldTicks: 1 });
  expect(scheduler._getOpenAutoDispatchHoldForTests()).toBeNull();
});

test('ac-4: the open hold is persisted and restored across a simulated restart', async () => {
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(96, reset);
  queueOne();
  await scheduler.tickQueue();
  const sidecar = JSON.parse(fs.readFileSync(schedulerPaths.schedulerStatePath(), 'utf8'));
  expect(sidecar.openAutoDispatchHold).toMatchObject({
    holdKey: `utilization-held|weekly_all|${new Date(reset).toISOString()}`,
    reason: 'utilization-held',
    window: 'weekly_all',
    threshold: 90,
    resetsAt: new Date(reset).toISOString(),
    maxPercent: 96,
    heldTicks: 1,
  });
  expect(Number.isFinite(Date.parse(sidecar.openAutoDispatchHold.startedAt))).toBe(true);

  // Restart: memory gone, boot loader restores from the sidecar.
  scheduler._forgetOpenAutoDispatchHoldForTests();
  scheduler.loadSchedulerState();
  expect(scheduler._getOpenAutoDispatchHoldForTests()).toMatchObject({ holdKey: sidecar.openAutoDispatchHold.holdKey });

  await reading(97, reset);
  await scheduler.tickQueue();
  expect(holdEvents().map((e) => e.kind)).toEqual(['auto_dispatch_hold_started']);

  await reading(10, reset);
  await scheduler.tickQueue();
  const ev = holdEvents();
  expect(ev.map((e) => e.kind)).toEqual(['auto_dispatch_hold_started', 'auto_dispatch_hold_ended']);
  expect(ev[1]).toMatchObject({ endedAcrossRestart: true, startedAt: sidecar.openAutoDispatchHold.startedAt, maxPercent: 97, heldTicks: 2 });
  expect(JSON.parse(fs.readFileSync(schedulerPaths.schedulerStatePath(), 'utf8')).openAutoDispatchHold).toBeNull();
});

test('ac-4: an invalid persisted open hold restores as null', async () => {
  const p = schedulerPaths.schedulerStatePath();
  const sidecar = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...sidecar, openAutoDispatchHold: { holdKey: 'x', startedAt: 'not-a-date' } }));
  scheduler.loadSchedulerState();
  expect(scheduler._getOpenAutoDispatchHoldForTests()).toBeNull();
});

test('ac-6: an audit write failure never throws out of the tick', async () => {
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(96, reset);
  queueOne();
  vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('disk full'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await scheduler.tickQueue();
  expect(r.reason).toBe('utilization-held');
  expect(auditLog).toBeTruthy();
});

test('continuity: resetsAt hh:mm:29.6 then hh:mm:30.4 (holdIdentityKey flips) writes no ended/started pair', async () => {
  const base = minuteReset(7 * DAY + HOUR);
  await reading(95, base + 29_600);
  queueOne();
  await scheduler.tickQueue();
  await reading(96, base + 30_400);
  await scheduler.tickQueue();
  const ev = holdEvents();
  expect(ev.map((e) => e.kind)).toEqual(['auto_dispatch_hold_started']);
  expect(scheduler._getOpenAutoDispatchHoldForTests()).toMatchObject({ holdKey: ev[0].holdKey, maxPercent: 96, heldTicks: 2 });
});

test('continuity: a resetsAt moved by 2 minutes writes ended then started', async () => {
  const base = minuteReset(7 * DAY + HOUR);
  await reading(95, base);
  queueOne();
  await scheduler.tickQueue();
  await reading(95, base + 2 * MINUTE);
  await scheduler.tickQueue();
  const ev = holdEvents();
  expect(ev.map((e) => e.kind)).toEqual(['auto_dispatch_hold_started', 'auto_dispatch_hold_ended', 'auto_dispatch_hold_started']);
  expect(ev[1].holdKey).toBe(ev[0].holdKey);
  expect(ev[2].holdKey).not.toBe(ev[0].holdKey);
});

test('startObserved: a held first tick after boot writes startObserved false', async () => {
  scheduler._resetPreviousTickUnheldForTests();
  await reading(96, minuteReset(7 * DAY + HOUR));
  queueOne();
  await scheduler.tickQueue();
  const ev = holdEvents();
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ kind: 'auto_dispatch_hold_started', startObserved: false });
});

test('startObserved: an unheld tick then a held tick writes startObserved true', async () => {
  scheduler._resetPreviousTickUnheldForTests();
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(10, reset);
  await scheduler.tickQueue();
  await reading(96, reset);
  queueOne();
  await scheduler.tickQueue();
  const ev = holdEvents();
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ kind: 'auto_dispatch_hold_started', startObserved: true });
});

test('startObserved: a hold replaced by another reason while held writes startObserved false', async () => {
  scheduler._resetPreviousTickUnheldForTests();
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(10, reset);
  await scheduler.tickQueue();
  await reading(96, reset);
  queueOne();
  await scheduler.tickQueue();
  await reading(10, reset, 99);
  await scheduler.tickQueue();
  const ev = holdEvents();
  const started = ev.filter((e) => e.kind === 'auto_dispatch_hold_started');
  expect(started).toHaveLength(2);
  expect(started[0].startObserved).toBe(true);
  expect(started[0].window).toBe('weekly_all');
  expect(started[1].window).toBe('session');
  expect(started[1].startObserved).toBe(false);
});

test('drift: resetsAt moving 40 s later on each of five held ticks writes one started event and no ended', async () => {
  const base = minuteReset(7 * DAY + HOUR);
  await reading(95, base);
  queueOne();
  await scheduler.tickQueue();
  for (let i = 1; i <= 5; i += 1) {
    await reading(95, base + i * 40_000);
    await scheduler.tickQueue();
  }
  expect(holdEvents().map((e) => e.kind)).toEqual(['auto_dispatch_hold_started']);
  const open = scheduler._getOpenAutoDispatchHoldForTests();
  expect(open.resetsAt).toBe(new Date(base).toISOString());
  expect(open.lastResetsAt).toBe(new Date(base + 5 * 40_000).toISOString());
  expect(open.heldTicks).toBe(6);
  const sidecar = JSON.parse(fs.readFileSync(schedulerPaths.schedulerStatePath(), 'utf8'));
  expect(sidecar.openAutoDispatchHold.lastResetsAt).toBe(new Date(base + 5 * 40_000).toISOString());

  await reading(10, base);
  await scheduler.tickQueue();
  const ended = holdEvents()[1];
  expect(ended).toMatchObject({
    kind: 'auto_dispatch_hold_ended',
    resetsAt: new Date(base).toISOString(),
    lastResetsAt: new Date(base + 5 * 40_000).toISOString(),
  });
});

test('drift: a restored open hold without lastResetsAt continues under its resetsAt', async () => {
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(96, reset);
  queueOne();
  await scheduler.tickQueue();
  const p = schedulerPaths.schedulerStatePath();
  const sidecar = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete sidecar.openAutoDispatchHold.lastResetsAt;
  fs.writeFileSync(p, JSON.stringify(sidecar));
  scheduler._forgetOpenAutoDispatchHoldForTests();
  scheduler.loadSchedulerState();
  expect(scheduler._getOpenAutoDispatchHoldForTests().lastResetsAt).toBe(new Date(reset).toISOString());
  await reading(96, reset + 30_000);
  await scheduler.tickQueue();
  expect(holdEvents().map((e) => e.kind)).toEqual(['auto_dispatch_hold_started']);
});
