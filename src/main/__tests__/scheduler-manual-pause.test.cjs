/**
 * scheduler-manual-pause.test.cjs — user-initiated pause (schedule:pause /
 * POST /admin/scheduler/pause). A 'manual' pause stops NEW dispatch, never
 * kills running jobs, survives restart, and is cleared only by an explicit
 * Resume / Run now — never by the rate-limit reset timer or network recovery.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-manual-pause.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-manual-pause-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await scheduler.clearPause('manual');
});

test('pause engages reason "manual" with no resumeAt, even inside the manual-override cooldown', async () => {
  await scheduler.clearPause('manual'); // starts the 5-minute cooldown
  await scheduler.setPaused('manual', null);
  const state = await queueStore.readMerged();
  expect(state.paused).toBeTruthy();
  expect(state.paused.reason).toBe('manual');
  expect(state.paused.resumeAt).toBeNull();
});

test('a manual pause never arms a resume time, even if a resumeAt is supplied', async () => {
  await scheduler.setPaused('manual', new Date(Date.now() + 3_600_000).toISOString());
  const state = await queueStore.readMerged();
  expect(state.paused.resumeAt).toBeNull();
});

test('pause blocks tickQueue dispatch', async () => {
  await scheduler.setPaused('manual', null);
  const result = await scheduler.tickQueue();
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('paused');
});

test('an auto rate_limit / network / auth pause cannot displace a manual pause', async () => {
  await scheduler.setPaused('manual', null);
  await scheduler.setPaused('rate_limit', new Date(Date.now() + 3_600_000).toISOString());
  await scheduler.setPaused('network', null);
  await scheduler.setPaused('auth', null);
  const state = await queueStore.readMerged();
  expect(state.paused.reason).toBe('manual');
  expect(state.paused.resumeAt).toBeNull();
});

test('poll recovery and the resume-time computation never clear/arm a manual pause', () => {
  expect(scheduler.pollRecoveryClearSource('manual', true)).toBeNull();
  expect(scheduler.pollRecoveryClearSource('manual', false)).toBeNull();
  expect(scheduler.computeEffectiveResumeAt('manual', null)).toBeNull();
});

test('a running job survives a pause untouched', async () => {
  const projectCwd = fs.mkdtempSync(path.join(tmpHome, 'pause-survivor-'));
  const slugDir = path.join(tmpHome, '.claude', 'projects', 'pause-survivor-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd: projectCwd }) + '\n');
  queueStore.bustCwdCache();
  const stateDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({
    jobs: [{ slug: 'pause-survivor', status: 'running', cwd: projectCwd, pid: process.pid, runId: 'r1', startedAt: new Date().toISOString() }],
  }));
  await scheduler.setPaused('manual', null);
  const state = await queueStore.readMerged();
  const row = state.jobs.find((j) => j.slug === 'pause-survivor');
  expect(row.status).toBe('running');
  expect(row.runId).toBe('r1');
});

test('a manual pause survives restart (re-read from disk; boot never clears it)', async () => {
  await scheduler.setPaused('manual', null);
  const onDisk = await queueStore.readMerged(); // what a fresh process reads at boot
  expect(onDisk.paused.reason).toBe('manual');
  // Boot only clears a pause whose resumeAt has elapsed / re-arms one with a
  // resumeAt; a manual pause has none, so neither branch applies.
  expect(onDisk.paused.resumeAt).toBeNull();
});

test('resume clears a manual pause', async () => {
  await scheduler.setPaused('manual', null);
  await scheduler.clearPause('manual');
  const state = await queueStore.readMerged();
  expect(state.paused).toBeNull();
});

test('remote.pause / remote.resume are the admin-route twins of the IPC handlers', async () => {
  expect(await scheduler.remote.pause()).toEqual({ ok: true });
  expect((await queueStore.readMerged()).paused.reason).toBe('manual');
  expect(await scheduler.remote.resume()).toEqual({ ok: true });
  expect((await queueStore.readMerged()).paused).toBeNull();
});
