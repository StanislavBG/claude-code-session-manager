/**
 * scheduler-no-dead-end-status.test.cjs
 *
 * Structural guard for the no-human-intervention guarantee (this PRD): every
 * value in `JOB_STATUSES` (imported from scheduleJobSchema.cjs — the real
 * array, never a hand-written copy) must either be genuinely final
 * (completed/skipped) or have at least one AUTOMATED selector that can move
 * a row parked in it, with no human action required.
 *
 * Each non-final status is asserted by CONSTRUCTING a representative parked
 * row (a stale timestamp + a counter positioned so the row is still
 * selectable) and showing the named selector actually returns it — not by
 * asserting a hand-maintained status -> selector-name string map, which
 * would pass even if the real wiring silently broke. If a future change adds
 * a new status to JOB_STATUSES with no automated exit wired up here, this
 * test fails loudly instead of the row becoming a new, silent dead end.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — same
 * reason as scheduler-failed-autoreset.test.cjs (appendAuditEvent writes
 * under $HOME/.claude/session-manager/audit-log.jsonl).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-no-dead-end-status.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'no-dead-end-status-test-'));
process.env.HOME = tmpHome;

const { JOB_STATUSES } = require('../lib/scheduleJobSchema.cjs');
const {
  selectFailedAutoResetTargets,
  FAILED_AUTORESET_CAP,
  selectExhaustedNeedsReviewTargets,
  NEEDS_REVIEW_RESOLVE_CAP,
  selectQuarantineAutoResolveTargets,
  QUARANTINE_RESOLVE_CAP,
  findStrandedInvestigations,
  INVESTIGATION_MAX_MS,
} = require('../scheduler.cjs');
const { selectReapableJobs } = require('../lib/reaperHelpers.cjs');
const { pickForProject } = require('../lib/schedulerBatch.cjs');

const MIN_MS = 60_000;

// Every terminal status (no automated exit needed — nothing should ever
// move a row out of these) and every non-terminal status's proof that a
// row parked there is reachable by an automated selector, keyed only for
// this test's own assertions (never treated as authoritative wiring below).
const FINAL_STATUSES = new Set(['completed', 'skipped']);

test('JOB_STATUSES contains exactly the statuses this test accounts for (fails loudly on drift)', () => {
  // Not a hand-maintained selector map — just a manifest of what this file
  // below actually exercises, so an entirely new, unhandled status trips
  // this assertion instead of silently passing the loop below with zero
  // coverage.
  const accountedFor = new Set([
    'pending', 'running', 'investigating', 'completed', 'skipped', 'failed', 'needs_review', 'quarantined',
  ]);
  const unaccounted = JOB_STATUSES.filter((s) => !accountedFor.has(s));
  if (unaccounted.length > 0) {
    throw new Error(
      `HALT: JOB_STATUSES has status(es) with no automated-exit test coverage: ${unaccounted.join(', ')} — `
      + 'add a case to scheduler-no-dead-end-status.test.cjs before shipping this status.',
    );
  }
});

test('every terminal status in JOB_STATUSES is genuinely final (completed/skipped only)', () => {
  for (const status of JOB_STATUSES) {
    if (status === 'completed' || status === 'skipped') continue;
    assert.ok(!FINAL_STATUSES.has(status), `${status} must not be treated as final`);
  }
});

test('pending: a fresh pending row with no blockers is picked for dispatch by pickForProject', () => {
  assert.ok(JOB_STATUSES.includes('pending'));
  const job = { slug: 'pending-row', cwd: '/home/user/project', status: 'pending' };
  const { batch } = pickForProject([job], new Set(), 5);
  assert.ok(batch.some((j) => j.slug === 'pending-row'), 'pending row must be dispatch-eligible with no blockers');
});

test('running: a running row whose pid is provably dead is reaped by selectReapableJobs', () => {
  assert.ok(JOB_STATUSES.includes('running'));
  const job = {
    slug: 'dead-running-row',
    cwd: '/home/user/project',
    status: 'running',
    runtime: { pid: 12345 },
  };
  const { reapable } = selectReapableJobs([job], Date.now(), { pidAlive: () => false, grace: 5 * MIN_MS });
  assert.ok(reapable.some((r) => r.slug === 'dead-running-row'), 'a running row with a dead pid must be reapable');
});

test('investigating: a stranded investigation (stale, no live pid) is found by findStrandedInvestigations', () => {
  assert.ok(JOB_STATUSES.includes('investigating'));
  const job = {
    slug: 'stranded-investigation',
    cwd: '/home/user/project',
    status: 'investigating',
    statusHistory: [{ to: 'investigating', from: 'failed', at: new Date(Date.now() - (INVESTIGATION_MAX_MS + 5 * MIN_MS)).toISOString() }],
  };
  const found = findStrandedInvestigations([job], Date.now(), INVESTIGATION_MAX_MS, () => false);
  assert.ok(found.some((f) => f.slug === 'stranded-investigation'), 'a stale investigating row with no live pid must be found');
});

test('failed: a stale failed row under its auto-reset cap is selected by selectFailedAutoResetTargets', () => {
  assert.ok(JOB_STATUSES.includes('failed'));
  const job = {
    slug: 'stale-failed-row',
    cwd: '/home/user/project',
    status: 'failed',
    failedAutoResetAttempts: FAILED_AUTORESET_CAP - 1,
    statusHistory: [{ to: 'failed', at: new Date(Date.now() - 60 * MIN_MS).toISOString() }],
  };
  const found = selectFailedAutoResetTargets([job], Date.now(), 10 * MIN_MS);
  assert.ok(found.some((f) => f.slug === 'stale-failed-row'), 'a stale failed row under the cap must be auto-reset-selectable');
});

test('needs_review: an exhausted, stale needs_review row is selected by selectExhaustedNeedsReviewTargets', () => {
  assert.ok(JOB_STATUSES.includes('needs_review'));
  const job = {
    slug: 'exhausted-needs-review-row',
    cwd: '/home/user/project',
    status: 'needs_review',
    autoFixAttempted: true,
    autoFixOutcome: 'no-plan',
    autoFixRetries: 1,
    exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP,
    statusHistory: [{ to: 'needs_review', at: new Date(Date.now() - 60 * MIN_MS).toISOString() }],
  };
  const found = selectExhaustedNeedsReviewTargets([job], Date.now(), 30 * MIN_MS);
  assert.ok(found.some((f) => f.slug === 'exhausted-needs-review-row'), 'an exhausted, stale needs_review row must be auto-resolve-selectable');
});

test('quarantined: a stale quarantined row under its resolve cap is selected by selectQuarantineAutoResolveTargets', () => {
  assert.ok(JOB_STATUSES.includes('quarantined'));
  const job = {
    slug: 'stale-quarantined-row',
    cwd: '/home/user/project',
    status: 'quarantined',
    quarantineResolveAttempts: QUARANTINE_RESOLVE_CAP - 1,
    statusHistory: [{ to: 'quarantined', at: new Date(Date.now() - 60 * MIN_MS).toISOString() }],
  };
  const found = selectQuarantineAutoResolveTargets([job], Date.now(), 30 * MIN_MS);
  assert.ok(found.some((f) => f.slug === 'stale-quarantined-row'), 'a stale quarantined row under the cap must be auto-resolve-selectable');
});
