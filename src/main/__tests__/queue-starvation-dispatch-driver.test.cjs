/**
 * queue-starvation-dispatch-driver.test.cjs — two liveness gaps in the
 * queue-starvation watchdog itself, both observed live on 2026-09-11
 * (27 pending jobs across two projects, 0 running, for days):
 *
 * 1. classifyQueueStarvation/runQueueStarvationWatchdog used to measure
 *    idleness from `lastRunAt`, which the poll loop kept looking fresh even
 *    while nothing was actually dispatching — masking the very stall the
 *    watchdog exists to catch. It must measure from `lastDispatchAttemptAt`
 *    instead (stamped by tickQueue() the moment it reaches the picker,
 *    regardless of outcome — see tickQueue's own comment).
 * 2. tickQueue()'s very first real guard returns {fired:false,
 *    reason:'cancelled'} whenever the in-process cancelToken is wedged
 *    true — historically only ever reset by runDueJobs() (force-tick/
 *    run-now/resume-timer). A pause that clears WITHOUT going through
 *    clearPause() (e.g. a direct queue-state write) leaves the token
 *    wedged forever with nothing left to un-wedge it. The starvation
 *    watchdog is the last line of defence, so it must reset the token
 *    itself before forcing its tick.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/queue-starvation-dispatch-driver.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let originalClaudeBin;
let originalAutofixDisable;
let scheduler;
let queueStore;

// A forced tick actually dispatches the one pending job it finds. Without a
// stub, that spawns the real `claude` binary (or fails trying to), leaving
// scheduler.cjs's module-scoped runningSet non-empty by the time the next
// test in this file runs — classifyQueueStarvation's `runningCount > 0`
// guard then makes runQueueStarvationWatchdog return null for a reason that
// has nothing to do with what that test is actually checking.
function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
}

beforeAll(() => {
  originalHome = process.env.HOME;
  originalClaudeBin = process.env.SM_CLAUDE_BIN;
  originalAutofixDisable = process.env.SM_AUTOFIX_DISABLE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-starve-driver-'));
  process.env.HOME = tmpHome;
  process.env.SM_CLAUDE_BIN = writeClaudeStub();
  // The forced tick's dispatched job has no PRD file and makes no commit, so
  // it lands 'needs_review' and (without this) immediately fires a
  // fire-and-forget auto-fix investigation — ANOTHER real claude spawn, under
  // its own queue row, that can still be in runningSet by the time the next
  // test in this file reads it (see writeClaudeStub's header comment; this
  // closes the same gap one layer further down the cascade).
  process.env.SM_AUTOFIX_DISABLE = '1';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalClaudeBin === undefined) delete process.env.SM_CLAUDE_BIN;
  else process.env.SM_CLAUDE_BIN = originalClaudeBin;
  if (originalAutofixDisable === undefined) delete process.env.SM_AUTOFIX_DISABLE;
  else process.env.SM_AUTOFIX_DISABLE = originalAutofixDisable;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// allProjectCwds()/activeProjectCwds() (queueStore.cjs's stateCwds) discover
// project cwds by scanning ~/.claude/projects/*/*.jsonl for a `cwd` field —
// fake one project transcript pointing at the fixture cwd, same pattern as
// prdAdminRoutes.test.cjs / scheduler-verify-prd-path.test.cjs.
function mkProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-starve-driver-project-'));
  const slug = `9002-starve-driver-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const projDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'projects', 'sm-starve-driver-fake-'));
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd })}\n`, 'utf8');
  return { cwd, slug };
}

test('ticks that launch nothing do NOT refresh the clock — idleness reads lastRunAt, not lastDispatchAttemptAt', async () => {
  const { cwd, slug } = mkProject();
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: [] }],
    config: {},
    paused: null,
  });

  const now = Date.now();
  // The structural repeat of f18e161: the loop ticks every 30 s (so
  // lastDispatchAttemptAt is seconds old) but nothing has LAUNCHED in 40
  // minutes (lastRunAt). The boot stamp is aged out so it can't mask it.
  const bootedAtMs = now - 3 * 60 * 60_000;
  const state = {
    ...queueStore.readMergedSync(),
    lastRunAt: new Date(now - 40 * 60_000).toISOString(),
    lastDispatchAttemptAt: new Date(now - 5_000).toISOString(),
  };

  const verdict = await scheduler.runQueueStarvationWatchdog(state, { now, bootedAtMs });
  expect(verdict).not.toBeNull();
  expect(verdict.kind).toBe('starved');

  // The watchdog's forced tick above dispatches this job for real (see
  // writeClaudeStub's header comment) — tickQueue doesn't await the spawned
  // process to completion, so runningSet can still hold this slug for a
  // moment after this test's own `await` returns. Under a fast, unloaded
  // machine the stub exits before the NEXT test's watchdog call ever reads
  // runningSet, which is racy rather than deterministic — under a heavily
  // loaded machine (e.g. the full test:unit run) it reliably loses,
  // stranding a slug in runningSet and making
  // classifyQueueStarvation's `runningCount > 0` guard return null for the
  // next test, which has nothing to do with what that test actually checks.
  // Wait for this job to actually leave 'running' before moving on.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = queueStore.readMergedSync().jobs.find((j) => j.slug === slug);
    if (!row || row.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 25));
  }
});

test('a wedged cancelToken does not block the watchdog from actually driving a tick', async () => {
  const { cwd, slug } = mkProject();
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: [] }],
    config: {},
    paused: null,
  });

  // Wedge the in-process cancel token exactly the way a pause does, then
  // clear the pause through a path that does NOT run clearPause()'s own
  // applyPauseCleared reset (a direct state write, not the clearPause()
  // helper) — leaving the token permanently cancelled with paused: null.
  await scheduler.setPaused('rate_limit', null);
  // setPaused's own broadcast({flush:true}) and a still-draining
  // fire-and-forget mutate() from the PRIOR test's forced dispatch (e.g.
  // tickQueue's own finally-chained call) both write through the SAME
  // serialized mutate() queue this raw writeQueue() call bypasses — one of
  // them can land AFTER this write and re-persist the stale paused:{...}
  // object it read before this clear, purely by losing the race. Re-assert
  // paused:null until it actually sticks, rather than trusting one write to
  // win a race against mutations this test doesn't control the timing of.
  const pausedClearDeadline = Date.now() + 5_000;
  do {
    await scheduler.writeQueue({
      jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: [] }],
      config: {},
      paused: null,
    });
    if (!queueStore.readMergedSync().paused) break;
    await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < pausedClearDeadline);

  const before = queueStore.readMergedSync().lastDispatchAttemptAt;

  const now = Date.now();
  const state = {
    ...queueStore.readMergedSync(),
    lastRunAt: new Date(now - 40 * 60_000).toISOString(),
    lastDispatchAttemptAt: new Date(now - 40 * 60_000).toISOString(),
  };
  const verdict = await scheduler.runQueueStarvationWatchdog(state, { now, bootedAtMs: now - 3 * 60 * 60_000 });
  expect(verdict.kind).toBe('starved');

  // tickQueue() only stamps lastDispatchAttemptAt once it gets PAST the
  // cancelToken guard — so this only advances if the watchdog actually
  // un-wedged the token before forcing its tick.
  const after = queueStore.readMergedSync().lastDispatchAttemptAt;
  expect(after).not.toBe(before);
  expect(after).not.toBeNull();
});

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const CWD = '/tmp/sm-starve-clock-project';
const pendingRow = (slug, extra = {}) => ({ slug, cwd: CWD, status: 'pending', dependsOn: [], ...extra });
const idleFor = (ms) => NOW - ms;

test('a real launch (fresh lastRunAt) refreshes the clock; so do a pause clear and a boot', () => {
  const jobs = [pendingRow('a')];
  const base = { jobs, paused: null, runningCount: 0, now: NOW };
  const stale = idleFor(3 * 60 * 60_000);
  expect(scheduler.classifyQueueStarvation({ ...base, lastRunAtMs: stale }).kind).toBe('starved');
  expect(scheduler.classifyQueueStarvation({ ...base, lastRunAtMs: idleFor(5_000) })).toBeNull();
  expect(scheduler.classifyQueueStarvation({ ...base, lastRunAtMs: stale, lastPauseClearedAtMs: idleFor(5_000) })).toBeNull();
  expect(scheduler.classifyQueueStarvation({ ...base, lastRunAtMs: stale, schedulerBootedAtMs: idleFor(5_000) })).toBeNull();
  expect(scheduler.dispatchIdleMs({ lastRunAtMs: 1000, lastPauseClearedAtMs: 4000, schedulerBootedAtMs: 2000, now: 10_000 })).toBe(6000);
  expect(scheduler.dispatchIdleMs({ now: 10_000 })).toBe(Infinity);
});

test('rows held by a launch breaker / lease read blocked, not starved (per project too)', () => {
  const jobs = [pendingRow('a'), pendingRow('b')];
  const args = { jobs, paused: null, runningCount: 0, lastRunAtMs: idleFor(3 * 60 * 60_000), now: NOW };
  expect(scheduler.classifyQueueStarvation(args).kind).toBe('starved');
  const partial = scheduler.classifyQueueStarvation({ ...args, heldSlugs: new Set(['a']) });
  expect(partial.kind).toBe('starved');
  expect(partial.dispatchable).toBe(1);
  const all = scheduler.classifyQueueStarvation({ ...args, heldSlugs: new Map([['a', 'x'], ['b', 'y']]) });
  expect(all.kind).toBe('blocked');
  expect(all.dispatchable).toBe(0);
  const byProject = scheduler.classifyQueueStarvationByProject({
    jobs, paused: null, runningSet: new Set(), lastRunAtMs: args.lastRunAtMs, heldSlugs: new Set(['a', 'b']), now: NOW,
  });
  expect(byProject.map((v) => v.kind)).toEqual(['blocked']);
});

test('the watchdog latches: one forced tick / audit per starve episode, re-armed by threshold or running-count change', async () => {
  const cwd = '/tmp/sm-starve-latch-project';
  const jobs = [{ slug: 'latch-a', cwd, status: 'pending', dependsOn: [] }];
  const opts = { bootedAtMs: NOW - 3 * 60 * 60_000 };
  const state = { jobs, paused: null, lastRunAt: new Date(NOW - 40 * 60_000).toISOString() };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const starvedLogs = () => warn.mock.calls.filter((c) => String(c[0]).includes('QUEUE STARVED')).length;
  try {
    // The row exists only in this hand-built state, never in queue.json, so
    // the forced tick has nothing real to launch.
    expect((await scheduler.runQueueStarvationWatchdog(state, { now: NOW, ...opts })).kind).toBe('starved');
    expect(starvedLogs()).toBe(1);
    // Same episode, well inside QUEUE_STARVATION_MS: still reported, not re-forced.
    expect((await scheduler.runQueueStarvationWatchdog(state, { now: NOW + 60_000, ...opts })).kind).toBe('starved');
    expect(starvedLogs()).toBe(1);
    // QUEUE_STARVATION_MS elapsed again: a new episode.
    await scheduler.runQueueStarvationWatchdog(state, { now: NOW + scheduler.QUEUE_STARVATION_MS + 1, ...opts });
    expect(starvedLogs()).toBe(2);
  } finally {
    warn.mockRestore();
  }
});
