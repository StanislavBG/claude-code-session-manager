/**
 * scheduler-adopted-run-supervision.test.cjs — an executor the boot spared
 * (`adoptedAtBoot`) is supervised like a freshly spawned one: budget, idle-tail
 * and deadman re-armed from the durable record, quietMachine lease re-acquired,
 * and a budget kill parks needs_review/budget_exceeded via classifyBudgetKill.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-adopted-run-supervision.test.cjs
 */

'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
const { superviseAdoptedRuns, evaluateAdoptedRun } = require('../lib/adoptedRunSupervisor.cjs');
const quietMachineLease = require('../lib/quietMachineLease.cjs');
const { classifyBudgetKill } = require('../scheduler.cjs');

const MIN = 60_000;
const T0 = Date.parse('2026-09-18T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  quietMachineLease.__resetForTests();
});
afterEach(() => {
  vi.useRealTimers();
  quietMachineLease.__resetForTests();
});

function harness({ rows, records, logMtimeMs = () => Date.now(), alive = () => true }) {
  const kills = [];
  const stamps = [];
  const supervised = [];
  const registry = new Map();
  const ctx = {
    registry,
    runDir: (j) => `/runs/${j.runId}`,
    readRecord: (_dir, slug) => records[slug] ?? null,
    lease: quietMachineLease,
    markSupervised: async (j) => { supervised.push(j.slug); },
    makeDeps: (j, record) => ({
      logPath: `/runs/${j.runId}/${j.slug}.log`,
      statLogMtimeMs: () => logMtimeMs(j.slug),
      pidAlive: alive,
      identityOf: () => record.identity,
      isDifferentProcess: () => false,
      killGroup: (pgid, signal) => { kills.push({ slug: j.slug, pgid, signal }); },
      stampKill: async (kind, reason) => { stamps.push({ slug: j.slug, kind, reason }); },
      checkIntervalMs: MIN,
      sigkillAfterMs: 30_000,
      defaultMaxDurationMs: 4 * 60 * MIN,
    }),
  };
  return { ctx, kills, stamps, supervised, registry, run: () => superviseAdoptedRuns(rows, ctx) };
}

const row = (slug, extra = {}) => ({ slug, status: 'running', runId: 'r1', adoptedAtBoot: new Date(T0).toISOString(), ...extra });
const record = (slug, extra = {}) => ({
  slug, pid: 4242, pgid: 4242, identity: { startTicks: 1 }, startedAt: T0, budgetMs: 45 * MIN, maxDurationMs: null, idleKillMs: 20 * MIN, ...extra,
});

test('an adopted run past its budget is killed and its budget kill classifies needs_review/budget_exceeded', async () => {
  const h = harness({ rows: [row('over')], records: { over: record('over', { startedAt: T0 - 50 * MIN }) } });
  expect(await h.run()).toEqual(['over']);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.stamps).toHaveLength(1);
  expect(h.stamps[0].kind).toBe('budget');
  expect(h.kills).toEqual([{ slug: 'over', pgid: 4242, signal: 'SIGTERM' }]);
  // SIGKILL follows if the group survives SIGTERM.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.kills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  // Same classifier as a native budget kill.
  const outcome = classifyBudgetKill({ killedByWatchdog: h.stamps[0].kind, budgetKillReason: h.stamps[0].reason, exitCode: null }, null);
  expect(outcome.status).toBe('needs_review');
  expect(outcome.reason).toMatch(/wall-clock budget exceeded/);
});

test('a run within budget is untouched until the interval crosses the budget', async () => {
  const h = harness({ rows: [row('ok')], records: { ok: record('ok', { startedAt: T0 - 10 * MIN }) } });
  await h.run();
  await vi.advanceTimersByTimeAsync(5 * MIN);
  expect(h.kills).toEqual([]);
  expect(h.stamps).toEqual([]);
  // 10m + 36m elapsed > 45m budget: the re-armed interval now fires.
  await vi.advanceTimersByTimeAsync(31 * MIN);
  expect(h.stamps.map((s) => s.kind)).toEqual(['budget']);
  expect(h.kills[0].signal).toBe('SIGTERM');
});

test('idle-tail: a stalled log past idleKillMs is SIGTERMed; deadman SIGKILLs at maxDurationMs', async () => {
  const idle = harness({
    rows: [row('idle')], records: { idle: record('idle', { startedAt: T0 - 5 * MIN }) },
    logMtimeMs: () => T0 - 25 * MIN,
  });
  await idle.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(idle.stamps.map((s) => s.kind)).toEqual(['idle-tail']);
  expect(idle.kills[0].signal).toBe('SIGTERM');

  const dead = harness({
    rows: [row('dm')], records: { dm: record('dm', { startedAt: T0 - 5 * MIN, budgetMs: null, maxDurationMs: 4 * 60 * MIN }) },
  });
  await dead.run();
  await vi.advanceTimersByTimeAsync(4 * 60 * MIN);
  expect(dead.stamps.map((s) => s.kind)).toEqual(['deadman']);
  expect(dead.kills.map((k) => k.signal)).toEqual(['SIGKILL']);
});

test('a null record.maxDurationMs falls back to the native 4h deadman', () => {
  const rec = record('x', { budgetMs: null, startedAt: T0 - 5 * 60 * MIN });
  expect(evaluateAdoptedRun(rec, { now: T0, logMtimeMs: T0, defaultMaxDurationMs: 4 * 60 * MIN })?.kind).toBe('deadman');
});

test('the quietMachine lease is re-acquired, supervisedAt stamped once, and an exempt (null budget) run is not budget-killed', async () => {
  const h = harness({
    rows: [row('quiet', { quietMachine: true })],
    records: { quiet: record('quiet', { budgetMs: null, startedAt: T0 - 90 * MIN }) },
  });
  expect(await h.run()).toEqual(['quiet']);
  expect(quietMachineLease.holder()).toBe('quiet');
  expect(h.supervised).toEqual(['quiet']);
  await vi.advanceTimersByTimeAsync(10 * MIN);
  expect(h.kills).toEqual([]);
  // A second dispatch-loop pass does not re-arm or re-stamp.
  expect(await h.run()).toEqual([]);
  expect(h.supervised).toEqual(['quiet']);
});

test('a pid that is gone is never signalled; rows that stop running drop their supervisor', async () => {
  const h = harness({
    rows: [row('gone')], records: { gone: record('gone', { startedAt: T0 - 90 * MIN }) }, alive: () => false,
  });
  await h.run();
  await vi.advanceTimersByTimeAsync(2 * MIN);
  expect(h.kills).toEqual([]);
  expect(h.stamps).toEqual([]);

  const live = harness({ rows: [row('fin')], records: { fin: record('fin') } });
  await live.run();
  expect(live.registry.size).toBe(1);
  await superviseAdoptedRuns([{ slug: 'fin', status: 'completed', runId: 'r1' }], live.ctx);
  expect(live.registry.size).toBe(0);
});
