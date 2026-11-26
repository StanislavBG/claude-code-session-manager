// Wiring: driveUpgradeDrain and clearStaleDrainAtBoot must hand the scheduler's
// SCHEDULER_BOOTED_AT to upgradeDrain (the pure fns are tested in upgradeDrain.test.cjs).
// The scheduler loop is never started; the restart handler is a stub.
import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp;
let savedHome;
let scheduler;
let upgradeDrain;
let schedulerPaths;
let auditLog;

beforeAll(() => {
  savedHome = process.env.SM_SCHEDULER_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-drain-bootedat-'));
  process.env.SM_SCHEDULER_HOME = tmp;
  scheduler = require('../scheduler.cjs');
  upgradeDrain = require('../lib/scheduler/upgradeDrain.cjs');
  schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
  auditLog = require('../lib/telemetry/auditLog.cjs');
  scheduler.__setRestartHandlerForTests(async () => { throw new Error('restart handler must not run'); });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.unlinkSync(schedulerPaths.restartRequestPath()); } catch { /* absent */ }
});

afterAll(() => {
  scheduler.__setRestartHandlerForTests(null);
  if (savedHome === undefined) delete process.env.SM_SCHEDULER_HOME; else process.env.SM_SCHEDULER_HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePredatingRequest() {
  const requestedAt = new Date(Date.parse(scheduler.SCHEDULER_BOOTED_AT) - 60_000).toISOString();
  fs.writeFileSync(schedulerPaths.restartRequestPath(), JSON.stringify({ reason: 't', requestedBy: 'test', requestedAt }));
}

function auditKinds() {
  const p = schedulerPaths.auditLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('driveUpgradeDrain passes bootedAt: SCHEDULER_BOOTED_AT to evaluateDrain', async () => {
  const spy = vi.spyOn(upgradeDrain, 'evaluateDrain');
  await scheduler.__driveUpgradeDrain({ jobs: [], drain: null });
  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls[0][0].bootedAt).toBe(scheduler.SCHEDULER_BOOTED_AT);
});

test('clearStaleDrainAtBoot passes bootedAt: SCHEDULER_BOOTED_AT to bootDrainAction', async () => {
  const spy = vi.spyOn(upgradeDrain, 'bootDrainAction');
  await scheduler.__clearStaleDrainAtBoot({ drain: null });
  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls[0][0].bootedAt).toBe(scheduler.SCHEDULER_BOOTED_AT);
});

test('a request predating boot is aborted by one driveUpgradeDrain pass', async () => {
  writePredatingRequest();
  const before = auditKinds().length;
  await scheduler.__driveUpgradeDrain({ jobs: [], drain: null });
  expect(fs.existsSync(schedulerPaths.restartRequestPath())).toBe(false);
  const events = auditKinds().slice(before).filter((e) => e.kind === 'upgrade_drain_aborted');
  expect(events.length).toBe(1);
  expect(JSON.stringify(events[0])).toContain('request-predates-boot');
  const state = await scheduler._mutateForTests((s) => ({ drain: s.drain ?? null }));
  expect(state?.drain ?? null).toBeNull();
});
