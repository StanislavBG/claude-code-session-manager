/**
 * scheduler-held-turns-drain.test.cjs — scheduler.cjs drains the held
 * scheduler-turn store only once no usage hold is in force, drops an
 * auto-start follow-up that no longer needs a plan, audits each delivered tab,
 * and reports the held count on the heartbeat line.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-held-turns-drain.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
const heldSchedulerTurns = require('../lib/scheduler/heldSchedulerTurns.cjs');
const scheduler = require('../scheduler.cjs');

const HB = () => schedulerPaths.heartbeatPath();
const lastLine = () => JSON.parse(fs.readFileSync(HB(), 'utf8').trim().split('\n').pop());
const HOLD = { reason: 'utilization-held', detail: '91% of 5h' };

// The run-wide sandbox home is shared by every worker; this file writes the
// heartbeat log and held store, so give it a private scheduler home.
let prevHome;
let privateHome;
beforeAll(() => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  privateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-held-turns-drain-'));
  process.env.SM_SCHEDULER_HOME = privateHome;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(privateHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.mkdirSync(path.dirname(schedulerPaths.heldSchedulerTurnsPath()), { recursive: true });
  fs.rmSync(schedulerPaths.heldSchedulerTurnsPath(), { force: true });
  fs.mkdirSync(path.dirname(HB()), { recursive: true });
  fs.rmSync(HB(), { force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function deps(over = {}) {
  return {
    hold: () => null,
    send: vi.fn(async () => ({ disposition: 'started' })),
    needsPlan: vi.fn(() => true),
    audit: vi.fn(),
    ...over,
  };
}

test('no drain while the hold is in force', async () => {
  heldSchedulerTurns.defer({ tabId: 't1', prompt: 'job A done', kind: 'job-notice', hold: HOLD });
  const d = deps({ hold: () => HOLD });
  const res = await scheduler.drainHeldSchedulerTurns(d);
  expect(res).toEqual([]);
  expect(d.send).not.toHaveBeenCalled();
  expect(d.audit).not.toHaveBeenCalled();
  expect(heldSchedulerTurns.summary().count).toBe(1);
});

test('one coalesced drain per tab after the hold clears, audited', async () => {
  heldSchedulerTurns.defer({ tabId: 't1', prompt: 'job A done', kind: 'job-notice', hold: HOLD });
  heldSchedulerTurns.defer({ tabId: 't1', prompt: 'plan settled', kind: 'settle-digest', hold: HOLD });
  const d = deps();
  const res = await scheduler.drainHeldSchedulerTurns(d);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send.mock.calls[0][0]).toBe('t1');
  expect(d.send.mock.calls[0][1]).toContain('job A done');
  expect(d.send.mock.calls[0][1]).toContain('plan settled');
  expect(res).toEqual([{ tabId: 't1', delivered: 2, dropped: 0 }]);
  expect(d.audit).toHaveBeenCalledWith('scheduler_turns_delivered', { tabId: 't1', delivered: 2, dropped: 0 });
  expect(heldSchedulerTurns.summary().count).toBe(0);
  // Nothing held → a later pass does not send again.
  await scheduler.drainHeldSchedulerTurns(d);
  expect(d.send).toHaveBeenCalledTimes(1);
});

test('an auto-start follow-up that no longer needs a plan is dropped, not sent', async () => {
  heldSchedulerTurns.defer({
    tabId: 't2', prompt: 'write a plan', kind: 'auto-start-follow-up', sessionId: 's2', cwd: '/proj', hold: HOLD,
  });
  const d = deps({ needsPlan: vi.fn(() => false) });
  const res = await scheduler.drainHeldSchedulerTurns(d);
  expect(d.needsPlan).toHaveBeenCalledWith('/proj', 's2');
  expect(d.send).not.toHaveBeenCalled();
  expect(res).toEqual([{ tabId: 't2', delivered: 0, dropped: 1 }]);
  expect(d.audit).toHaveBeenCalledWith('scheduler_turns_delivered', { tabId: 't2', delivered: 0, dropped: 1 });
  expect(heldSchedulerTurns.summary().count).toBe(0);
});

test('non-auto-start kinds never consult autoStartNeedsPlan', async () => {
  heldSchedulerTurns.defer({ tabId: 't3', prompt: 'notice', kind: 'job-notice', cwd: '/p', sessionId: 's', hold: HOLD });
  const d = deps({ needsPlan: vi.fn(() => false) });
  await scheduler.drainHeldSchedulerTurns(d);
  expect(d.needsPlan).not.toHaveBeenCalled();
  expect(d.send).toHaveBeenCalledTimes(1);
});

test('heartbeat line carries heldSchedulerTurns { count, tabs }', () => {
  const q = () => ({ jobs: [], unreadable: true, paused: null });
  const noDrain = vi.fn(async () => []);
  scheduler.heartbeatTick({ readQueueSync: q, drainHeldSchedulerTurns: noDrain });
  expect(lastLine().heldSchedulerTurns).toEqual({ count: 0, tabs: [] });
  heldSchedulerTurns.defer({ tabId: 'a', prompt: 'p1', kind: 'job-notice' });
  heldSchedulerTurns.defer({ tabId: 'a', prompt: 'p2', kind: 'job-notice' });
  heldSchedulerTurns.defer({ tabId: 'b', prompt: 'p3', kind: 'job-notice' });
  scheduler.heartbeatTick({ readQueueSync: q, drainHeldSchedulerTurns: noDrain });
  expect(lastLine().heldSchedulerTurns).toEqual({ count: 3, tabs: ['a', 'b'] });
  expect(noDrain).toHaveBeenCalledTimes(2);
});
