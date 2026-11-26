'use strict';
/**
 * bindingWindowPauseThreshold (PRD 4532): the rate_limit pause's pro-rated
 * 'pause above' takes the window NAME from the same reading as the reset, so
 * a refreshed five_hour reading is never pro-rated against a cached weekly
 * window length.
 */
import { test, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// HOME points at a temp dir BEFORE scheduler.cjs loads: the end-to-end test
// below drives reapDeadRunningJobs, which reads and writes queue + machine state.
const originalHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-window-pause-threshold-'));
process.env.HOME = tmpHome;

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const { __test, billingReadingForPause, reapDeadRunningJobs } = require('../scheduler.cjs');
const billing = require('../usage.cjs');
const schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
const { writeRunLog } = require('./_helpers/schedulerHarness.cjs');
const { PRO_RATE_CEILING } = require('../scheduler/utilizationHold.cjs');
// Five-hour window, 4 h left (f = 0.8): base 90 pro-rates 28% of the way to the ceiling.
const FIVE_HOUR_EXPECTED = 90 + (PRO_RATE_CEILING - 90) * 0.28;

const { bindingWindowPauseThreshold } = __test;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-24T12:00:00.000Z');

async function withUsage(limits, fn) {
  const original = billing.fetchUsage;
  billing.fetchUsage = async () => ({ kind: 'ok', data: { usage: { limits } } });
  try {
    return await fn();
  } finally {
    billing.fetchUsage = original;
  }
}

test('weekly_all reset 41 h ahead with base 90 -> PRO_RATE_CEILING', () => {
  const t = bindingWindowPauseThreshold(90, { window: 'weekly_all', resetsAt: new Date(NOW + 41 * HOUR).toISOString() }, NOW);
  assert.strictEqual(t, PRO_RATE_CEILING);
});

test('five_hour reset 4 h ahead with a weekly cached name -> the five-hour value (~92.5), not the weekly one', async () => {
  // Seed the cache with a weekly binding window.
  await withUsage(
    [{ kind: 'weekly_all', percent: 64, resets_at: new Date(NOW + 41 * HOUR).toISOString(), scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  const resetsAt = new Date(NOW + 4 * HOUR).toISOString();
  // Cached name alone (weekly) with this reset would pro-rate to the ceiling.
  assert.strictEqual(bindingWindowPauseThreshold(90, { window: 'weekly_all', resetsAt }, NOW), PRO_RATE_CEILING);
  const t = bindingWindowPauseThreshold(90, { window: 'five_hour', resetsAt }, NOW);
  assert.ok(Math.abs(t - FIVE_HOUR_EXPECTED) < 0.01, `threshold ${t}`);
});

test('billingReadingForPause pairs the refreshed window name with its reset', async () => {
  await withUsage(
    [{ kind: 'weekly_all', percent: 64, resets_at: new Date(NOW + 41 * HOUR).toISOString(), scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  const resetsAt = new Date(NOW + 4 * HOUR).toISOString();
  const reading = await withUsage(
    [{ kind: 'five_hour', percent: 95, resets_at: resetsAt, scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  assert.deepStrictEqual(reading, { window: 'five_hour', resetsAt });
  const t = bindingWindowPauseThreshold(90, reading, NOW);
  assert.ok(Math.abs(t - FIVE_HOUR_EXPECTED) < 0.01, `threshold ${t}`);
});

test('no reading passed -> the cached pair', async () => {
  const resetsAt = new Date(NOW + 41 * HOUR).toISOString();
  await withUsage(
    [{ kind: 'weekly_all', percent: 64, resets_at: resetsAt, scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  assert.strictEqual(bindingWindowPauseThreshold(90, null, NOW), PRO_RATE_CEILING);
  assert.strictEqual(bindingWindowPauseThreshold('x', null, NOW), 'x');
});

test('rate_limit reap pause end to end: weekly cached name + refreshed five_hour reading 4 h before reset, base 90 -> the five-hour value (~92.5) decides', async () => {
  const now = Date.now();
  // Cache a weekly binding window name (and its far reset).
  await withUsage(
    [{ kind: 'weekly_all', percent: 64, resets_at: new Date(now + 41 * HOUR).toISOString(), scope: null, is_active: true }],
    () => billingReadingForPause(),
  );

  // Project with one running row whose dead process's log shows a 429 and no
  // rate_limit_event reset, so the pause falls back to the billing reading.
  const cwd = path.join(tmpHome, 'rl-project');
  fs.mkdirSync(cwd, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', 'rl-project-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  require('../lib/activeSessions.cjs').__resetProjectCwdCacheForTests();
  require('../lib/scheduler/queueStore.cjs').bustCwdCache();
  const slug = 'rl-job';
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Test fixture PRD.', 'utf8');
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({
    jobs: [{ slug, status: 'running', cwd, runId: 'run-rl', startedAt: new Date(now - 10 * 60_000).toISOString(), runtime: { pid: 999999 } }],
  }, null, 2));
  writeRunLog('run-rl', slug, [
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'API Error: 429' }),
  ]);
  const machinePath = schedulerPaths.machineStatePath();
  fs.mkdirSync(path.dirname(machinePath), { recursive: true });
  fs.writeFileSync(machinePath, JSON.stringify({ config: { utilizationThreshold: 90 } }, null, 2));

  // Refreshed reading: five_hour at 93% (above the five-hour pro-rated ~92.5,
  // below the weekly pro-rated ceiling), resetting 4 h from now.
  const fiveHourReset = new Date(now + 4 * HOUR).toISOString();
  await withUsage(
    [{ kind: 'five_hour', percent: 93, resets_at: fiveHourReset, scope: null, is_active: true }],
    () => reapDeadRunningJobs(),
  );

  const machine = JSON.parse(fs.readFileSync(machinePath, 'utf8'));
  assert.strictEqual(machine.paused?.reason, 'rate_limit', JSON.stringify(machine.paused));
  // Weekly pairing (threshold = ceiling) would reject 93% and arm the 30-minute
  // fallback; the five-hour pairing (~92.5) accepts it and pauses to its reset.
  assert.strictEqual(machine.paused.resumeAt, fiveHourReset, JSON.stringify(machine.paused));
  // The scheduler's own threshold for that same reading, at the pause instant.
  const t = bindingWindowPauseThreshold(90, { window: 'five_hour', resetsAt: fiveHourReset }, now);
  assert.ok(Math.abs(t - FIVE_HOUR_EXPECTED) < 0.05, `threshold ${t}`);
});
