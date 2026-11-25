/**
 * scheduler-human-press-audit.test.cjs — a human Run now / Fire next batch now
 * press appends 'scheduler_human_press' (naming the hold in force, or null),
 * and a human tick that passes through an auto-dispatch hold appends
 * 'auto_dispatch_hold_bypassed' with the slugs it launches. Automatic ticks
 * write neither. 2026-11-24: under a usage hold a human launch could not be
 * told apart from a leak in audit-log.jsonl.
 *
 * Harness: scheduler-auto-dispatch-hold-audit.test.cjs (temp HOME, spawn recorder).
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-human-press-audit.test.cjs
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
let utilizationHold;
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
  const proj = makeProject(`press-audit-proj-${seq}`);
  const slug = `9303-press-audit-${process.pid}-${seq}`;
  fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: [{ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
  queueStore.bustCwdCache();
  return slug;
}

/** A reset time on an exact minute (±0.5 s never crosses holdIdentityKey rounding); callers pass > 7 days so the pro-rated threshold stays at the 90 base. */
function minuteReset(offsetMs) { return Math.round((Date.now() + offsetMs) / MINUTE) * MINUTE; }

function weeklyAt(pct, resetMs) {
  const session = { kind: 'session', percent: 10, resets_at: new Date(Date.now() + 2 * HOUR).toISOString(), scope: null };
  const limits = [session, { kind: 'weekly_all', percent: pct, resets_at: new Date(resetMs).toISOString(), scope: null }];
  return {
    kind: 'ok',
    data: { usage: { five_hour: { utilization: session.percent, resets_at: session.resets_at }, limits } },
  };
}

async function reading(pct, resetMs) {
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => weeklyAt(pct, resetMs);
  await scheduler.refreshNextReset();
}

function auditLines() {
  const p = schedulerPaths.auditLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Press / bypass audit events appended since the current test began. */
function pressEvents() {
  return auditLines().slice(auditMark).filter((e) => e.kind === 'scheduler_human_press' || e.kind === 'auto_dispatch_hold_bypassed');
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-human-press-audit-'));
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
  utilizationHold = require('../scheduler/utilizationHold.cjs');
  originalFetchUsage = billing.fetchUsage;
  scheduler._setSpawnJobForTests(async (job) => { spawned.push(job.slug); });
});

beforeEach(async () => {
  spawned = [];
  await scheduler._mutateForTests((s) => { s.config = { ...(s.config || {}), firePolicy: 'when-available', utilizationThreshold: 90 }; });
  await reading(10, minuteReset(7 * DAY + HOUR));
  await scheduler.tickQueue();
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

test('ac-1: a press with no hold in force records hold: null', async () => {
  await scheduler._auditHumanPressForTests('run-now');
  await scheduler._auditHumanPressForTests('force-tick');
  const ev = pressEvents();
  expect(ev.map((e) => [e.kind, e.press, e.hold])).toEqual([
    ['scheduler_human_press', 'run-now', null],
    ['scheduler_human_press', 'force-tick', null],
  ]);
});

test('ac-1: a press under a usage hold records the hold at press time', async () => {
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(96, reset);
  await scheduler._auditHumanPressForTests('force-tick');
  const ev = pressEvents();
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({
    kind: 'scheduler_human_press',
    press: 'force-tick',
    hold: { reason: 'utilization-held', window: 'weekly_all', percent: 96, threshold: 90, resetsAt: expect.any(String) },
  });
  expect(new Date(ev[0].hold.resetsAt).getTime()).toBe(reset);
  expect(ev[0].hold.holdKey).toBe(utilizationHold.holdIdentityKey(ev[0].hold));
  expect(typeof ev[0].hold.holdKey).toBe('string');
});

test('ac-2: a human tick through the hold records auto_dispatch_hold_bypassed with the launched slugs', async () => {
  const reset = minuteReset(7 * DAY + HOUR);
  await reading(96, reset);
  const slug = queueOne();
  const r = await scheduler.runDueJobs({ bypassLoadGate: true, human: true });
  expect(r.reason).not.toBe('utilization-held');
  expect(spawned).toContain(slug);
  const ev = pressEvents().filter((e) => e.kind === 'auto_dispatch_hold_bypassed');
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ reason: 'utilization-held', window: 'weekly_all', percent: 96, threshold: 90 });
  expect(new Date(ev[0].resetsAt).getTime()).toBe(reset);
  expect(ev[0].holdKey).toBe(utilizationHold.holdIdentityKey(ev[0]));
  expect(ev[0].dispatched).toContain(slug);
  expect(ev[0].dispatched.length).toBe(spawned.length);
});

test('ac-2: a human tick through the hold with nothing to launch records dispatched: []', async () => {
  await reading(96, minuteReset(7 * DAY + HOUR));
  // Every row from earlier tests has already launched into the recorder or is non-pending.
  await scheduler._mutateForTests((s) => { for (const j of s.jobs) if (j.status === 'pending') j.status = 'skipped'; });
  await scheduler.runDueJobs({ bypassLoadGate: true, human: true });
  const ev = pressEvents().filter((e) => e.kind === 'auto_dispatch_hold_bypassed');
  expect(ev).toHaveLength(1);
  expect(ev[0].dispatched).toEqual([]);
});

test('ac-3: an automatic tick under the hold writes neither event', async () => {
  await reading(96, minuteReset(7 * DAY + HOUR));
  queueOne();
  const r = await scheduler.tickQueue();
  expect(r.reason).toBe('utilization-held');
  await scheduler.runDueJobs({ bypassLoadGate: true });
  expect(pressEvents()).toEqual([]);
});

test('ac-3: a human tick with no hold in force writes no auto_dispatch_hold_bypassed', async () => {
  queueOne();
  await scheduler.runDueJobs({ bypassLoadGate: true, human: true });
  expect(pressEvents().filter((e) => e.kind === 'auto_dispatch_hold_bypassed')).toEqual([]);
});

test('ac-5: an audit write failure never throws out of the press or the tick', async () => {
  await reading(96, minuteReset(7 * DAY + HOUR));
  queueOne();
  vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('disk full'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(scheduler._auditHumanPressForTests('run-now')).resolves.toBeUndefined();
  const r = await scheduler.runDueJobs({ bypassLoadGate: true, human: true });
  expect(r.reason).not.toBe('utilization-held');
});

test('continuity: a human bypass after a resetsAt jitter across hh:mm:30 carries the started event holdKey', async () => {
  const base = minuteReset(7 * DAY + HOUR);
  await reading(96, base + 29_600);
  queueOne();
  await scheduler.tickQueue();
  const started = auditLines().slice(auditMark).filter((e) => e.kind === 'auto_dispatch_hold_started');
  expect(started).toHaveLength(1);
  await reading(96, base + 30_400);
  const slug = queueOne();
  await scheduler.runDueJobs({ bypassLoadGate: true, human: true });
  await scheduler._auditHumanPressForTests('run-now');
  expect(spawned).toContain(slug);
  const bypass = pressEvents().filter((e) => e.kind === 'auto_dispatch_hold_bypassed');
  expect(bypass).toHaveLength(1);
  expect(utilizationHold.holdIdentityKey(bypass[0])).not.toBe(started[0].holdKey);
  expect(bypass[0].holdKey).toBe(started[0].holdKey);
  const press = pressEvents().filter((e) => e.kind === 'scheduler_human_press');
  expect(press.at(-1).hold.holdKey).toBe(started[0].holdKey);
  expect(auditLines().slice(auditMark).filter((e) => e.kind === 'auto_dispatch_hold_started' || e.kind === 'auto_dispatch_hold_ended')).toHaveLength(1);
});
