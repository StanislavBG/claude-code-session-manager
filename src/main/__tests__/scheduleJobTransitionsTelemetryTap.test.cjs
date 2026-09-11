/**
 * scheduleJobTransitionsTelemetryTap.test.cjs — transitionJob() is the ONE
 * chokepoint every job status change flows through (scheduleJobTransitions.
 * cjs's own header); this asserts it fires the 'scheduler.job.finish'
 * counter exactly once when a run genuinely finishes (running -> a terminal
 * status), and not on other legal edges (retries, admin resets).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduleJobTransitionsTelemetryTap.test.cjs
 */
'use strict';

import { test, expect, afterEach, beforeEach } from 'vitest';

const countersPath = require.resolve('../lib/telemetryCounters.cjs');
const transitionsPath = require.resolve('../lib/scheduleJobTransitions.cjs');

let calls;

beforeEach(() => {
  calls = [];
  require.cache[countersPath] = {
    id: countersPath,
    filename: countersPath,
    loaded: true,
    exports: { trackSchedulerJobFinish: (props) => calls.push(props) },
  };
  delete require.cache[transitionsPath];
});

afterEach(() => {
  delete require.cache[countersPath];
  delete require.cache[transitionsPath];
});

function freshJob(status) {
  return { slug: 'test-slug', status, cwd: '/tmp/whatever' };
}

test('running -> completed fires scheduler.job.finish once with { status: "completed" }', () => {
  const { transitionJob } = require('../lib/scheduleJobTransitions.cjs');
  const job = freshJob('running');
  expect(transitionJob(job, 'completed', { reason: 'run succeeded', source: 'test' })).toBe(true);
  expect(calls).toEqual([{ status: 'completed' }]);
});

test('running -> failed fires scheduler.job.finish once with { status: "failed" }', () => {
  const { transitionJob } = require('../lib/scheduleJobTransitions.cjs');
  const job = freshJob('running');
  transitionJob(job, 'failed', { reason: 'run failed', source: 'test' });
  expect(calls).toEqual([{ status: 'failed' }]);
});

test('running -> pending (retry) does NOT fire scheduler.job.finish', () => {
  const { transitionJob } = require('../lib/scheduleJobTransitions.cjs');
  const job = freshJob('running');
  transitionJob(job, 'pending', { reason: 'transient retry', source: 'test' });
  expect(calls).toEqual([]);
});

test('pending -> running (dispatch) does NOT fire scheduler.job.finish', () => {
  const { transitionJob } = require('../lib/scheduleJobTransitions.cjs');
  const job = freshJob('pending');
  transitionJob(job, 'running', { reason: 'dispatch', source: 'test' });
  expect(calls).toEqual([]);
});

test('an illegal (refused) transition does NOT fire scheduler.job.finish', () => {
  const { transitionJob } = require('../lib/scheduleJobTransitions.cjs');
  const job = freshJob('completed');
  expect(transitionJob(job, 'running', { reason: 'bogus', source: 'test' })).toBe(false);
  expect(calls).toEqual([]);
});
