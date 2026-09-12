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

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let originalClaudeBin;
let scheduler;
let queueStore;

// A forced tick actually dispatches the one pending job it finds. Without a
// stub, that spawns the real `claude` binary (or fails trying to), leaving
// scheduler.cjs's module-scoped runningSet non-empty by the time the next
// test in this file runs — classifyQueueStarvation's `runningCount > 0`
// guard then makes runQueueStarvationWatchdog return null for a reason that
// has nothing to do with what that test is actually checking.
function writeClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-starve-driver-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  originalClaudeBin = process.env.SM_CLAUDE_BIN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-starve-driver-'));
  process.env.HOME = tmpHome;
  process.env.SM_CLAUDE_BIN = writeClaudeStub();
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalClaudeBin === undefined) delete process.env.SM_CLAUDE_BIN;
  else process.env.SM_CLAUDE_BIN = originalClaudeBin;
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

test('the watchdog reads idleness from lastDispatchAttemptAt, not the always-fresh poll timestamp', async () => {
  const { cwd, slug } = mkProject();
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: [] }],
    config: {},
    paused: null,
  });

  const now = Date.now();
  // The exact shape of the live incident: the poll timestamp is seconds old
  // (the poll loop itself keeps succeeding), but nothing has actually
  // attempted a dispatch in 40 minutes.
  const state = {
    ...queueStore.readMergedSync(),
    lastRunAt: new Date(now - 5_000).toISOString(),
    lastDispatchAttemptAt: new Date(now - 40 * 60_000).toISOString(),
  };

  const verdict = await scheduler.runQueueStarvationWatchdog(state, { now });
  expect(verdict).not.toBeNull();
  expect(verdict.kind).toBe('starved');
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
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: [] }],
    config: {},
    paused: null,
  });

  const before = queueStore.readMergedSync().lastDispatchAttemptAt;

  const now = Date.now();
  const state = {
    ...queueStore.readMergedSync(),
    lastRunAt: null,
    lastDispatchAttemptAt: new Date(now - 40 * 60_000).toISOString(),
  };
  const verdict = await scheduler.runQueueStarvationWatchdog(state, { now });
  expect(verdict.kind).toBe('starved');

  // tickQueue() only stamps lastDispatchAttemptAt once it gets PAST the
  // cancelToken guard — so this only advances if the watchdog actually
  // un-wedged the token before forcing its tick.
  const after = queueStore.readMergedSync().lastDispatchAttemptAt;
  expect(after).not.toBe(before);
  expect(after).not.toBeNull();
});
