/**
 * queue-starvation-per-project.test.cjs — classifyQueueStarvation's
 * runningCount used to be fed the MACHINE-WIDE runningSet.size, so one
 * long-lived job in ANY project disarmed the starvation watchdog for EVERY
 * other project on the box. Observed live 2026-09-12: a job in
 * starry-night-ships ran 80+ minutes while two other projects sat
 * starved/blocked for hours — the watchdog never fired once because "work is
 * flowing" was true somewhere else.
 *
 * classifyQueueStarvationByProject partitions jobs by cwd (the same grouping
 * computeBlockedChains already uses) and evaluates each project on its OWN
 * running/pending/idle evidence.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/queue-starvation-per-project.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// HOME before require: every state path is baked from os.homedir() at load.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'starve-per-project-test-'));

const {
  classifyQueueStarvation,
  classifyQueueStarvationByProject,
  QUEUE_STARVATION_MS,
} = require('../scheduler.cjs');

const PROJECT_A = '/home/bilko/Projects/starry-night-ships';
const PROJECT_B = '/home/bilko/Projects/session-manager';
const NOW = Date.parse('2026-09-12T20:00:00.000Z');
const LONG = QUEUE_STARVATION_MS + 60_000;
const idleFor = (ms) => NOW - ms;

test('one long-running job in project A no longer masks project B being starved', () => {
  const jobs = [
    { slug: '246-neptune', cwd: PROJECT_A, status: 'running', dependsOn: [] },
    { slug: '1169-x', cwd: PROJECT_B, status: 'pending', dependsOn: [] },
    { slug: '1170-y', cwd: PROJECT_B, status: 'pending', dependsOn: [] },
  ];

  // Pre-change shape: the machine-wide runningCount (1, from project A) hides
  // project B's starvation entirely. This is the bug this PRD fixes — assert
  // it still holds for the old, single-project entry point so a revert of
  // the new driver is caught by this test going red.
  const globalVerdict = classifyQueueStarvation({
    jobs,
    paused: false,
    runningCount: 1,
    lastRunAtMs: idleFor(LONG),
    now: NOW,
  });
  assert.equal(globalVerdict, null);

  // Per-project: project B has 0 of its OWN rows running and 2 dispatchable
  // pending rows idle past the threshold — it must be reported as starved
  // regardless of project A's running job.
  const verdicts = classifyQueueStarvationByProject({
    jobs,
    paused: false,
    runningSet: new Set(),
    lastRunAtMs: idleFor(LONG),
    now: NOW,
  });
  const forB = verdicts.find((v) => v.cwd === PROJECT_B);
  assert.ok(forB, 'expected a verdict naming project B cwd');
  assert.equal(forB.kind, 'starved');
  assert.equal(forB.pending, 2);
  assert.equal(forB.dispatchable, 2);

  // Project A itself has a running row — never starved on its own account.
  const forA = verdicts.find((v) => v.cwd === PROJECT_A);
  assert.equal(forA, undefined);
});

test('a project fully blocked behind a terminal dependency is "blocked", not "starved", even while another project is starved in the same pass', () => {
  const jobs = [
    // Project A: every pending row sits behind a failed dependency — a tick
    // cannot help this project, it needs a human/heal pass.
    { slug: '206-lava-ape', cwd: PROJECT_A, status: 'failed', dependsOn: [] },
    { slug: '207-body', cwd: PROJECT_A, status: 'pending', dependsOn: ['206-lava-ape'] },
    // Project B: dispatchable right now — genuinely starved.
    { slug: '1171-z', cwd: PROJECT_B, status: 'pending', dependsOn: [] },
  ];

  const verdicts = classifyQueueStarvationByProject({
    jobs,
    paused: false,
    runningSet: new Set(),
    lastRunAtMs: idleFor(LONG),
    now: NOW,
  });

  const forA = verdicts.find((v) => v.cwd === PROJECT_A);
  assert.ok(forA, 'expected a verdict for the blocked project');
  assert.equal(forA.kind, 'blocked');

  const forB = verdicts.find((v) => v.cwd === PROJECT_B);
  assert.ok(forB, 'expected a verdict for the starved project');
  assert.equal(forB.kind, 'starved');
});

test('the whole-machine paused short-circuit is preserved for every project', () => {
  const jobs = [
    { slug: '1169-x', cwd: PROJECT_A, status: 'pending', dependsOn: [] },
    { slug: '1170-y', cwd: PROJECT_B, status: 'pending', dependsOn: [] },
  ];
  const verdicts = classifyQueueStarvationByProject({
    jobs,
    paused: { reason: 'rate_limit', resumeAt: null },
    runningSet: new Set(),
    lastRunAtMs: idleFor(LONG),
    now: NOW,
  });
  assert.deepEqual(verdicts, []);
});

test('a running-set membership (not just a status:"running" row) counts as that project having flowing work', () => {
  const jobs = [
    { slug: '9001-a', cwd: PROJECT_A, status: 'pending', dependsOn: [] },
  ];
  const verdicts = classifyQueueStarvationByProject({
    jobs,
    paused: false,
    runningSet: new Set(['9001-a']),
    lastRunAtMs: idleFor(LONG),
    now: NOW,
  });
  assert.deepEqual(verdicts, []);
});
