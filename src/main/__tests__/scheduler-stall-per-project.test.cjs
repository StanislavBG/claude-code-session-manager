/**
 * scheduler-stall-per-project.test.cjs — unit tests for computeStallSummary's
 * per-project `stalled` verdict and findStaleQuarantinedJobs' age-based
 * escalation.
 *
 * Covers the exact burrow-vs-others shape observed live: one project (burrow)
 * holds only quarantined rows (0 running, 0 pending) while another project
 * has running + pending work — the machine-wide `stalled` boolean reads
 * false (masking burrow), but burrow's own byProject entry must read true.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-stall-per-project.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (see CLAUDE.md:
// "This repo does not use `node --test`"). A node:test file loads under
// vitest as "No test suite found" and contributes zero tests, so the guard
// silently doesn't exist. node:assert works fine inside a vitest run.
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { computeStallSummary, findStaleQuarantinedJobs, QUARANTINE_ESCALATE_MS } = require('../scheduler.cjs');

test('computeStallSummary: burrow fully stalled (quarantined only) while another project is busy — machine-wide false, burrow true', () => {
  const state = {
    paused: null,
    jobs: [
      { slug: '821-a', cwd: '/home/bilko/Projects/burrow', status: 'quarantined' },
      { slug: '822-b', cwd: '/home/bilko/Projects/burrow', status: 'quarantined' },
      { slug: '823-c', cwd: '/home/bilko/Projects/burrow', status: 'quarantined' },
      { slug: '824-d', cwd: '/home/bilko/Projects/burrow', status: 'quarantined' },
      { slug: '900-e', cwd: '/home/bilko/Projects/other', status: 'running' },
      { slug: '901-f', cwd: '/home/bilko/Projects/other', status: 'pending' },
    ],
    invalidJobs: [],
  };
  const summary = computeStallSummary(state);
  assert.strictEqual(summary.stalled, false, 'machine-wide must NOT read stalled — other project is busy');
  assert.strictEqual(summary.byProject['/home/bilko/Projects/burrow'].stalled, true, 'burrow must read stalled on its own');
  assert.strictEqual(summary.byProject['/home/bilko/Projects/other'].stalled, false);
});

test('computeStallSummary: both projects busy — neither stalled', () => {
  const state = {
    paused: null,
    jobs: [
      { slug: 'a', cwd: '/p1', status: 'running' },
      { slug: 'b', cwd: '/p2', status: 'pending' },
    ],
    invalidJobs: [],
  };
  const summary = computeStallSummary(state);
  assert.strictEqual(summary.stalled, false);
  assert.strictEqual(summary.byProject['/p1'].stalled, false);
  assert.strictEqual(summary.byProject['/p2'].stalled, false);
});

test('computeStallSummary: both projects stalled — machine-wide AND both per-project read true', () => {
  const state = {
    paused: null,
    jobs: [
      { slug: 'a', cwd: '/p1', status: 'failed' },
      { slug: 'b', cwd: '/p2', status: 'needs_review' },
    ],
    invalidJobs: [],
  };
  const summary = computeStallSummary(state);
  assert.strictEqual(summary.stalled, true);
  assert.strictEqual(summary.byProject['/p1'].stalled, true);
  assert.strictEqual(summary.byProject['/p2'].stalled, true);
});

test('computeStallSummary: paused scheduler never reads stalled, machine-wide or per-project', () => {
  const state = {
    paused: { reason: 'rate_limit' },
    jobs: [{ slug: 'a', cwd: '/p1', status: 'quarantined' }],
    invalidJobs: [],
  };
  const summary = computeStallSummary(state);
  assert.strictEqual(summary.stalled, false);
  assert.strictEqual(summary.byProject['/p1'].stalled, false);
});

test('findStaleQuarantinedJobs: fires past threshold, not before', () => {
  const now = Date.parse('2026-08-08T12:00:00.000Z');
  const jobs = [
    {
      slug: 'fresh',
      cwd: '/p1',
      status: 'quarantined',
      statusHistory: [{ to: 'quarantined', at: new Date(now - 1 * 60 * 60_000).toISOString() }],
    },
    {
      slug: 'stale',
      cwd: '/p1',
      status: 'quarantined',
      statusHistory: [{ to: 'quarantined', at: new Date(now - 25 * 60 * 60_000).toISOString() }],
    },
    {
      slug: 'exactly-at-threshold',
      cwd: '/p1',
      status: 'quarantined',
      statusHistory: [{ to: 'quarantined', at: new Date(now - QUARANTINE_ESCALATE_MS).toISOString() }],
    },
    { slug: 'no-history', cwd: '/p1', status: 'quarantined' },
    { slug: 'not-quarantined', cwd: '/p1', status: 'pending' },
  ];
  const stale = findStaleQuarantinedJobs(jobs, now, QUARANTINE_ESCALATE_MS);
  const slugs = stale.map((s) => s.slug).sort();
  assert.deepStrictEqual(slugs, ['exactly-at-threshold', 'stale']);
  assert.strictEqual(stale.find((s) => s.slug === 'stale').cwd, '/p1');
});
