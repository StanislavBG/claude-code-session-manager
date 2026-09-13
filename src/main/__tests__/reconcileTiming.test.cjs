/**
 * reconcileTiming.test.cjs — proves reconcile() (src/main/scheduler.cjs)
 * records a per-phase timing breakdown and emits exactly one warn-level
 * `logs.writeLine` when a pass exceeds RECONCILE_SLOW_PASS_MS
 * (src/main/lib/schedulerConfig.cjs), and stays silent on a normal-speed
 * pass. Before this, diagnosing a slow reconcile pass (the
 * "schedule.state timed out after 5000ms" toast) required hand-timing the
 * filesystem scans from a throwaway script.
 *
 * HOME-isolated (mirrors reconcileFlatPrdSweep.test.cjs): stub HOME to a
 * mkdtemp dir before requiring scheduler.cjs, and register the fixture
 * project as "active" via a fake ~/.claude/projects transcript — reconcile's
 * PRD discovery (prdLocations.cjs) only scans cwds it can find that way.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/reconcileTiming.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueHistory;
let logs;
let RECONCILE_SLOW_PASS_MS;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-timing-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');
  queueHistory = require('../lib/queueHistory.cjs');
  logs = require('../logs.cjs');
  ({ RECONCILE_SLOW_PASS_MS } = require('../lib/schedulerConfig.cjs'));

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerActiveProject(cwd);
  return cwd;
}

function writeCanonicalPrd(cwd, epicId, slug) {
  const epicPrdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
  fs.mkdirSync(epicPrdsDir, { recursive: true });
  fs.writeFileSync(
    path.join(epicPrdsDir, `${slug}.md`),
    `---\ntitle: Timing fixture\ncwd: ${cwd}\nestimateMinutes: 10\nsourcePromptId: ${epicId}\ncreatedVia: scheduler-api\nissuedAt: 2026-08-07T00:00:00.000Z\n---\n\n# Goal\n\nSomething.\n`,
    'utf8',
  );
}

function warnCallsMatching(spy) {
  return spy.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload?.level === 'warn' && payload?.scope === 'scheduler' && /reconcile\(\) pass took/.test(payload?.message ?? ''));
}

test('a normal-speed reconcile() pass logs nothing', async () => {
  const cwd = makeFixtureProject('sm-reconcile-timing-fast-proj-');
  writeCanonicalPrd(cwd, 'epic-fast', '1600-fast');

  const writeLineSpy = vi.spyOn(logs, 'writeLine');
  const state = { jobs: [], invalidJobs: [], paused: null };
  await scheduler.reconcile(state);

  expect(warnCallsMatching(writeLineSpy)).toHaveLength(0);
});

test('a slow reconcile() pass emits exactly one warn with the per-phase breakdown', async () => {
  const cwd = makeFixtureProject('sm-reconcile-timing-slow-proj-');
  writeCanonicalPrd(cwd, 'epic-slow', '1601-slow');

  const realHistoryTerminalBySlug = queueHistory.historyTerminalBySlug.bind(queueHistory);
  vi.spyOn(queueHistory, 'historyTerminalBySlug').mockImplementation(async (...args) => {
    await new Promise((resolve) => { setTimeout(resolve, RECONCILE_SLOW_PASS_MS + 200); });
    return realHistoryTerminalBySlug(...args);
  });
  const writeLineSpy = vi.spyOn(logs, 'writeLine');

  const state = { jobs: [], invalidJobs: [], paused: null };
  await scheduler.reconcile(state);

  const warnCalls = warnCallsMatching(writeLineSpy);
  expect(warnCalls).toHaveLength(1);
  const { meta } = warnCalls[0];
  expect(meta.totalMs).toBeGreaterThan(RECONCILE_SLOW_PASS_MS);
  expect(meta.phaseMs).toHaveProperty('flatPrdSweep');
  expect(meta.phaseMs).toHaveProperty('prdDirResolve');
  expect(meta.phaseMs).toHaveProperty('parseLoop');
  expect(meta.phaseMs).toHaveProperty('historyLookup');
  expect(meta.phaseMs).toHaveProperty('queueWrite');
  expect(meta.phaseMs.historyLookup).toBeGreaterThanOrEqual(RECONCILE_SLOW_PASS_MS);
  expect(typeof meta.prdFileCount).toBe('number');
  expect(typeof meta.resolvedDirCount).toBe('number');
  expect(meta.prdFileCount).toBeGreaterThanOrEqual(1);
}, 15_000);

test('reconcile() surfaces its own error and does not swallow it while timing', async () => {
  vi.spyOn(queueHistory, 'partitionJobs').mockImplementation(() => {
    throw new Error('boom: injected failure for timing-swallow test');
  });

  const cwd = makeFixtureProject('sm-reconcile-timing-throw-proj-');
  writeCanonicalPrd(cwd, 'epic-throw', '1602-throw');

  const state = { jobs: [], invalidJobs: [], paused: null };
  await expect(scheduler.reconcile(state)).rejects.toThrow('boom: injected failure for timing-swallow test');
});
