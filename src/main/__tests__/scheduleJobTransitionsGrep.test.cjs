/**
 * scheduleJobTransitionsGrep.test.cjs — asserts scheduleJobTransitions.cjs's
 * transitionJob() is the ONLY place a ScheduleJob's `status` field is
 * assigned, per the PRD that introduced it (job-lifecycle chokepoint,
 * mirroring epicMint.cjs's ownership of the Epic's status transition).
 *
 * A bare `job.status = '...'` reintroduces the exact failure class this
 * module exists to close: no legality check, no statusHistory trail, no
 * audit record — the 1021/1022 stall (2026-08-07) was undiagnosable from
 * the app because status changes left no trace beyond a heartbeat count.
 *
 * Deliberately a plain grep, not an AST walk — this repo's other structural
 * guards (check-unstable-selectors.cjs, check-conditional-hooks.cjs) use the
 * same grep-based approach for the same reason: fast, dependency-free, and
 * precise enough for a single well-known pattern.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduleJobTransitionsGrep.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const SCHEDULER_PATH = path.join(__dirname, '..', 'scheduler.cjs');

// Lines explicitly exempt: `entry.status = ...` inside listPrdsInternal
// assigns a freshly-synthesized PRD-listing row's display field, never a
// persisted ScheduleJob's status (no queue.json mutation, no
// statusHistory/audit trail applies). Each must carry the justifying
// comment referencing this test, so the exemption can't silently drift.
const ALLOWLISTED_PATTERN = /^\s*entry\.status = /;

test('no bare `.status = ` assignment on a job object outside scheduleJobTransitions.cjs', () => {
  const lines = fs.readFileSync(SCHEDULER_PATH, 'utf8').split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/\.status = /.test(line)) return;
    if (ALLOWLISTED_PATTERN.test(line)) return;
    offenders.push(`scheduler.cjs:${i + 1}: ${line.trim()}`);
  });
  expect(offenders).toEqual([]);
});

test('scheduler.cjs references transitionJob (the chokepoint is actually wired up)', () => {
  const content = fs.readFileSync(SCHEDULER_PATH, 'utf8');
  expect(content).toMatch(/require\(['"]\.\/lib\/scheduleJobTransitions\.cjs['"]\)/);
  // At least as many call sites as the PRD's own enumerated list — guards
  // against someone reverting individual sites back to bare assignment
  // without reintroducing the literal `.status = ` grep hit (e.g. swapping
  // in a different mutation helper that itself bypasses transitionJob).
  const callSites = content.match(/transitionJob\(/g) || [];
  expect(callSites.length).toBeGreaterThanOrEqual(17);
});

test('the allowlisted entry.status lines carry their justifying comment', () => {
  const content = fs.readFileSync(SCHEDULER_PATH, 'utf8');
  expect(content).toMatch(/exempt from the\s*\n\s*\/\/ transitionJob-only rule enforced by scheduleJobTransitionsGrep\.test\.cjs/);
});
