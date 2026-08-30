/**
 * scheduleJobSchema.test.cjs — unit tests for the canonical ScheduleJob zod
 * schema, its assertValidScheduleJob fail-closed helper, and queueStore.cjs's
 * shapeJobs on-read quarantine gate.
 *
 * Reproduces the 2026-08-07 incident: PRDs 1021/1022 (social-signals-trader)
 * sat unscheduled for 4+ hours because their queue.json rows carried
 * `"status": "queued"` — a value absent from ScheduleJobStatus — which every
 * picker silently skipped since none of them treat an unrecognized status as
 * an error.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduleJobSchema.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ScheduleJobSchema,
  JOB_STATUSES,
  assertValidScheduleJob,
} = require('../lib/scheduleJobSchema.cjs');
const { shapeJobs } = require('../lib/queueStore.cjs');

function validJob(overrides = {}) {
  return {
    slug: '1021-social-signals',
    title: 'Wire up social signals trader',
    cwd: '/home/bilko/Projects/social-signals-trader',
    parallelGroup: 1021,
    estimateMinutes: 30,
    bodyPreview: 'Do the thing.',
    status: 'pending',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    ...overrides,
  };
}

test('JOB_STATUSES matches ScheduleJobStatus', () => {
  expect(JOB_STATUSES).toEqual(['pending', 'running', 'investigating', 'completed', 'skipped', 'failed', 'needs_review', 'quarantined']);
});

test('a valid full job record parses', () => {
  const full = validJob({
    sessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    runtime: { pid: 123, runId: 'run-1', startedAt: '2026-08-07T00:00:00.000Z' },
    verifierVerdict: 'halt',
    dependsOn: ['1020-prereq'],
    originSessionId: 'orig-session',
    sourceTabId: 'tab-1',
    sourcePromptId: 'prompt-1',
    epicId: 'epic-1',
  });
  expect(() => assertValidScheduleJob(full)).not.toThrow();
  expect(ScheduleJobSchema.safeParse(full).success).toBe(true);
});

test('a job with an invalid status value fails', () => {
  const badStatus = validJob({ status: 'queued' });
  expect(() => assertValidScheduleJob(badStatus)).toThrow(/status/);
});

test('a job missing a required field fails', () => {
  const { slug, ...missingSlug } = validJob();
  expect(() => assertValidScheduleJob(missingSlug)).toThrow(/slug/);
});

// ---------- shapeJobs (the on-read quarantine gate) ----------

let tmpFile;
let errorSpy;

beforeEach(() => {
  tmpFile = path.join(
    os.tmpdir(),
    `scheduleJobSchema-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch { /* ok if absent */ }
  errorSpy.mockRestore();
});

test('a row with status "queued" (the 1021/1022 incident) is quarantined, logged, and absent from jobs', () => {
  fs.writeFileSync(tmpFile, JSON.stringify({
    jobs: [
      validJob({ slug: '1021-social-signals', status: 'queued' }),
      validJob({ slug: '1022-social-signals', status: 'queued' }),
      validJob({ slug: '1023-healthy', status: 'pending' }),
    ],
  }));

  const raw = fs.readFileSync(tmpFile, 'utf8');
  const { jobs, invalid } = shapeJobs(raw, tmpFile);

  expect(jobs.map((j) => j.slug)).toEqual(['1023-healthy']);
  expect(invalid.map((i) => i.slug)).toEqual(['1021-social-signals', '1022-social-signals']);
  expect(invalid[0].issues).toMatch(/status/);
  expect(invalid[0].file).toBe(tmpFile);

  expect(errorSpy).toHaveBeenCalledTimes(2);
  const firstCallArgs = errorSpy.mock.calls[0][0];
  expect(firstCallArgs).toContain(tmpFile);
  expect(firstCallArgs).toContain('1021-social-signals');
  expect(firstCallArgs).toMatch(/status/);
});

test('a fully valid row round-trips through shapeJobs unchanged', () => {
  const job = validJob({ slug: '1023-healthy' });
  fs.writeFileSync(tmpFile, JSON.stringify({ jobs: [job] }));

  const raw = fs.readFileSync(tmpFile, 'utf8');
  const { jobs, invalid } = shapeJobs(raw, tmpFile);

  expect(invalid).toEqual([]);
  expect(jobs).toEqual([job]);
  expect(errorSpy).not.toHaveBeenCalled();
});
