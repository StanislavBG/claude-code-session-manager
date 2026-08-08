/**
 * scheduleJobTransitions.test.cjs — unit tests for transitionJob(), the sole
 * chokepoint for a ScheduleJob's `status` field (scheduleJobTransitions.cjs).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduleJobTransitions.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  transitionJob,
  LEGAL_TRANSITIONS,
  STATUS_HISTORY_CAP,
  getRefusedTransitionCount,
  _resetRefusedTransitionCountForTests,
} = require('../lib/scheduleJobTransitions.cjs');
const auditLog = require('../lib/auditLog.cjs');

function uniqueSlug(label) {
  return `test-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

function readAuditRecordsForSlug(slug) {
  if (!fs.existsSync(auditLog.AUDIT_LOG_PATH)) return [];
  return fs.readFileSync(auditLog.AUDIT_LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((record) => record && record.slug === slug);
}

test('a legal transition mutates the job, records statusHistory, and audits', () => {
  const slug = uniqueSlug('legal');
  const job = { slug, cwd: '/tmp/proj', status: 'pending' };

  const ok = transitionJob(job, 'running', { reason: 'dispatched', source: 'test' });

  expect(ok).toBe(true);
  expect(job.status).toBe('running');
  expect(job.statusHistory).toHaveLength(1);
  expect(job.statusHistory[0]).toMatchObject({ from: 'pending', to: 'running', reason: 'dispatched', source: 'test' });
  expect(typeof job.statusHistory[0].at).toBe('string');

  const records = readAuditRecordsForSlug(slug);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: 'job_transition', slug, from: 'pending', to: 'running', reason: 'dispatched', source: 'test', cwd: '/tmp/proj' });
});

test('an illegal transition refuses: job untouched, error logged, counter incremented, audit written', () => {
  const slug = uniqueSlug('illegal');
  const job = { slug, cwd: '/tmp/proj', status: 'pending' };
  const before = getRefusedTransitionCount();

  const ok = transitionJob(job, 'needs_review', { reason: 'bogus', source: 'test' });

  expect(ok).toBe(false);
  expect(job.status).toBe('pending'); // untouched
  expect(job.statusHistory).toBeUndefined(); // never mutated
  expect(getRefusedTransitionCount()).toBe(before + 1);

  const records = readAuditRecordsForSlug(slug);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: 'job_transition_refused', slug, from: 'pending', to: 'needs_review' });
});

test('an identity transition (status unchanged) is accepted as a no-op with no history entry', () => {
  const slug = uniqueSlug('identity');
  const job = { slug, cwd: '/tmp/proj', status: 'running' };

  const ok = transitionJob(job, 'running', { reason: 'no-op', source: 'test' });

  expect(ok).toBe(true);
  expect(job.status).toBe('running');
  expect(job.statusHistory).toBeUndefined();
  expect(readAuditRecordsForSlug(slug)).toHaveLength(0);
});

test('statusHistory caps at STATUS_HISTORY_CAP entries, dropping the oldest first', () => {
  const slug = uniqueSlug('cap');
  const job = { slug, cwd: '/tmp/proj', status: 'pending' };

  // pending -> running -> pending -> running -> ... alternate legally more
  // than the cap, to exercise eviction.
  const cycles = STATUS_HISTORY_CAP + 5;
  for (let i = 0; i < cycles; i++) {
    const to = job.status === 'pending' ? 'running' : 'pending';
    expect(transitionJob(job, to, { reason: `cycle ${i}`, source: 'test' })).toBe(true);
  }

  expect(job.statusHistory).toHaveLength(STATUS_HISTORY_CAP);
  // Oldest entries (early cycles) were dropped — the earliest surviving
  // entry's reason should be from a late cycle, not "cycle 0".
  expect(job.statusHistory[0].reason).not.toBe('cycle 0');
  expect(job.statusHistory[job.statusHistory.length - 1].reason).toBe(`cycle ${cycles - 1}`);
});

test('LEGAL_TRANSITIONS covers every real scheduler.cjs edge', () => {
  // Spot-check the edges scheduler.cjs actually exercises, so a future prune
  // of this table can't silently break a real call site without a test
  // failure here pointing at it.
  const mustBeLegal = [
    ['pending', 'running'],
    ['pending', 'completed'],
    ['pending', 'failed'],
    ['running', 'completed'],
    ['running', 'failed'],
    ['running', 'needs_review'],
    ['running', 'pending'],
    ['investigating', 'failed'],
    ['investigating', 'needs_review'],
    ['investigating', 'pending'],
    ['failed', 'investigating'],
    ['failed', 'pending'],
    ['failed', 'completed'],
    ['needs_review', 'investigating'],
    ['needs_review', 'pending'],
    ['needs_review', 'completed'],
    ['completed', 'pending'],
  ];
  for (const [from, to] of mustBeLegal) {
    expect(LEGAL_TRANSITIONS[from]).toContain(to);
  }
});

test('a genuinely nonsensical edge (completed -> running) is illegal', () => {
  expect(LEGAL_TRANSITIONS.completed).not.toContain('running');
  const slug = uniqueSlug('nonsense');
  const job = { slug, cwd: '/tmp/proj', status: 'completed' };
  expect(transitionJob(job, 'running', { reason: 'nope', source: 'test' })).toBe(false);
  expect(job.status).toBe('completed');
});

test('transitionJob never throws on a missing/malformed job', () => {
  expect(transitionJob(null, 'running', {})).toBe(false);
  expect(transitionJob(undefined, 'running', {})).toBe(false);
  // status undefined -> 'running' is not a legal edge from any known state —
  // refused, not a crash.
  expect(transitionJob({}, 'running', {})).toBe(false);
});

test('_resetRefusedTransitionCountForTests resets the counter', () => {
  const slug = uniqueSlug('reset-counter');
  const job = { slug, status: 'completed' };
  transitionJob(job, 'running', {});
  expect(getRefusedTransitionCount()).toBeGreaterThan(0);
  _resetRefusedTransitionCountForTests();
  expect(getRefusedTransitionCount()).toBe(0);
});
