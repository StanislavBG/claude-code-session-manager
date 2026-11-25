/**
 * scheduler-auto-dispatch-hold.test.cjs — every AUTOMATIC tick holds at or
 * above config.utilizationThreshold (over every window of the last real
 * reading) and under firePolicy 'manual'; only a human tick bypasses it.
 * 2026-11-23: job-finish ticks kept dispatching at 96-100% weekly because only
 * maybeLaunchWhenAvailable checked the threshold.
 *
 * Launches go to an injected spawn recorder (_setSpawnJobForTests); every
 * reset time is relative to Date.now().
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-auto-dispatch-hold.test.cjs
 */
'use strict';

import { test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRD_BODY = '---\ntitle: Hold PRD\ncreatedVia: scheduler-api\n---\n\nHold PRD.\n';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let tmpHome;
let originalHome;
let originalMeminfo;
let scheduler;
let billing;
let queueStore;
let originalFetchUsage;
let spawned = [];
let seq = 0;

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

// One dispatchable row (no deps, PRD on disk): without the hold it launches.
function queueOne() {
  seq += 1;
  const proj = makeProject(`hold-proj-${seq}`);
  const slug = `9301-hold-${process.pid}-${seq}`;
  fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: [{ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
  queueStore.bustCwdCache();
  return slug;
}

function iso(offsetMs) { return new Date(Date.now() + offsetMs).toISOString(); }

function okUsage(limits) {
  const session = limits.find((l) => l.kind === 'session');
  return {
    kind: 'ok',
    data: { usage: { five_hour: session ? { utilization: session.percent, resets_at: session.resets_at } : undefined, limits } },
  };
}

// Resets past one week out keep the pro-rated threshold at the configured base (utilizationHold.proRatedThreshold).
const FULL_WINDOW = 7 * DAY + HOUR;
function weekly(pct, resetIn = FULL_WINDOW) {
  return okUsage([
    { kind: 'session', percent: 10, resets_at: iso(2 * HOUR), scope: null },
    { kind: 'weekly_all', percent: pct, resets_at: iso(resetIn), scope: null },
  ]);
}

async function goodReading(usage) {
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => usage;
  await scheduler.refreshNextReset();
}

function openCircuit() {
  for (let i = 0; i < 3; i += 1) billing.usageCircuit.recordFailure('x');
  expect(billing.usageCircuit.state()).toBe('open');
}

async function setFirePolicy(firePolicy) {
  await scheduler._mutateForTests((s) => { s.config = { ...(s.config || {}), firePolicy, utilizationThreshold: 90 }; });
}

function payloadNow() {
  return scheduler.buildScheduleStatePayload({ config: {}, jobs: [], lastRunAt: null, paused: null });
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-auto-hold-'));
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
  originalFetchUsage = billing.fetchUsage;
  scheduler._setSpawnJobForTests(async (job) => { spawned.push(job.slug); });
});

beforeEach(async () => {
  spawned = [];
  await setFirePolicy('when-available');
});

afterEach(() => {
  billing.fetchUsage = originalFetchUsage;
  vi.useRealTimers();
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

test('(a) the job-finish tick (tickQueue()) holds at 96% ≥ 90% and spawns nothing', async () => {
  await goodReading(weekly(96));
  queueOne();
  const r = await scheduler.tickQueue();
  expect(r).toMatchObject({ fired: false, reason: 'utilization-held' });
  expect(spawned).toEqual([]);
  expect(payloadNow().utilizationHold).toMatchObject({ window: 'weekly_all', percent: 96, threshold: 90 });
});

test('(b) open circuit after a good 96 reading holds; so does a failed half_open probe', async () => {
  await goodReading(weekly(96));
  queueOne();
  openCircuit();
  billing.fetchUsage = async () => { throw new Error('fetch must not run while the circuit is open'); };
  await scheduler.pollLoop();
  expect((await scheduler.tickQueue()).reason).toBe('utilization-held');

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 61_000);
  expect(billing.usageCircuit.state()).toBe('half_open');
  billing.fetchUsage = async () => {
    billing.usageCircuit.recordFailure('probe');
    return { kind: 'transient', message: 'probe failed' };
  };
  await scheduler.pollLoop();
  expect(billing.usageCircuit.state()).toBe('open');
  expect((await scheduler.tickQueue()).reason).toBe('utilization-held');
  expect(spawned).toEqual([]);
});

test('(d) firePolicy manual: an automatic tick returns manual-fire-policy', async () => {
  await goodReading(weekly(10));
  queueOne();
  await setFirePolicy('manual');
  const r = await scheduler.tickQueue();
  expect(r).toMatchObject({ fired: false, reason: 'manual-fire-policy' });
  expect(spawned).toEqual([]);
  expect(payloadNow().utilizationHold).toBeNull();
});

test('(e) a single reading whose reset already passed does not hold', async () => {
  await goodReading({ kind: 'ok', data: { usage: { five_hour: { utilization: 96, resets_at: iso(-60_000) } } } });
  queueOne();
  const r = await scheduler.tickQueue();
  expect(r.reason).not.toBe('utilization-held');
  expect(payloadNow().utilizationHold).toBeNull();
});

test('(f) the starvation watchdog forces no tick and warns nothing while the hold is in force', async () => {
  await goodReading(weekly(96));
  const now = Date.now();
  const state = {
    config: { firePolicy: 'when-available', utilizationThreshold: 90 },
    jobs: [{ slug: 'watchdog-held', cwd: '/tmp/sm-auto-hold-watchdog', status: 'pending', dependsOn: [] }],
    paused: null,
    lastRunAt: new Date(now - 40 * 60_000).toISOString(),
  };
  const tickSpy = vi.spyOn(scheduler, 'tickQueue').mockResolvedValue({ fired: false, reason: 'drained' });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const verdict = await scheduler.runQueueStarvationWatchdog(state, { now, bootedAtMs: now - 3 * HOUR });
    expect(verdict).toBeNull();
    expect(tickSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('QUEUE STARVED'))).toBe(false);
  } finally {
    tickSpy.mockRestore();
    warn.mockRestore();
  }
});

test("(g) Self's outage: the session window reset, weekly_all at 92% still holds", async () => {
  const weeklyReset = iso(FULL_WINDOW);
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => okUsage([
    { kind: 'session', percent: 97, resets_at: iso(-60_000), scope: null },
    { kind: 'weekly_all', percent: 92, resets_at: weeklyReset, scope: null },
  ]);
  await scheduler.pollLoop();
  openCircuit();
  billing.fetchUsage = async () => { throw new Error('fetch must not run while the circuit is open'); };
  await scheduler.pollLoop();
  queueOne();
  const r = await scheduler.tickQueue();
  expect(r).toMatchObject({ fired: false, reason: 'utilization-held' });
  expect(scheduler.buildScheduleStatePayload({ config: {}, jobs: [], lastRunAt: null, paused: null }).lastTick.detail)
    .toMatch(/weekly_all window at 92%/);
  expect(spawned).toEqual([]);
  // The snapshot field is the module variable the heartbeat also writes.
  expect(payloadNow().utilizationHold)
    .toEqual({ window: 'weekly_all', percent: 92, threshold: 90, baseThreshold: 90, resetsAt: weeklyReset });
});

test('(h) the same outage with both resets in the past does not hold', async () => {
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => okUsage([
    { kind: 'session', percent: 97, resets_at: iso(-60_000), scope: null },
    { kind: 'weekly_all', percent: 92, resets_at: iso(-30_000), scope: null },
  ]);
  await scheduler.pollLoop();
  openCircuit();
  billing.fetchUsage = async () => { throw new Error('fetch must not run while the circuit is open'); };
  await scheduler.pollLoop();
  queueOne();
  const r = await scheduler.tickQueue();
  expect(r.reason).not.toBe('utilization-held');
  expect(payloadNow().utilizationHold).toBeNull();
});

// Last: a human run launches the row (into the spawn recorder).
test('(c) a human runDueJobs at 96% gets past the hold', async () => {
  await goodReading(weekly(96));
  queueOne();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  let r;
  try { r = await scheduler.runDueJobs({ bypassLoadGate: true, human: true }); } finally { console.log = orig; }
  expect(r.reason).not.toBe('utilization-held');
  expect(logs.some((l) => l.includes('human run bypassed the hold'))).toBe(true);
  expect(spawned.length).toBeGreaterThan(0);
});
