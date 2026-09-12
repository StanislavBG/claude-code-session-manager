/**
 * scheduler-periodic-reverify-guard.test.cjs
 *
 * The 10-minute periodic tick cheap-guards reverifyNeedsReview() so the log
 * scan only runs when the queue actually holds something rescannable. That
 * guard was hand-written as `jobs.some(j => j.status === 'needs_review')`
 * while PRD 1102 widened isRescanCandidate to also accept an unverified-
 * shaped `failed` row — so reverifyNeedsReview's failed → needs_review
 * looksDone branch was unreachable from the periodic path on any queue with
 * zero needs_review rows. A failed row with no run log stayed wedged for five
 * days (reported 2026-09-10 from social-signals-trader); only an app restart,
 * via the unguarded boot call, could reach it.
 *
 * These tests pin the guard to isRescanCandidate so the two cannot drift again.
 *
 * Reopened 2026-09-12 through a different door (starry-night-ships
 * 231-saturn-record-and-docs / 243-neptune-kurama-mode): the guard also gates
 * reverifyNeedsReview's auto-fix loop, not just its re-verification arm, but
 * only checked isRescanCandidate — so a needs_review row whose mechanical
 * recovery already ran and failed (verdict 'worktree_integration_failed',
 * mechanicalRecoveryAttempted: true — not itself a RESCANNABLE_VERDICTS
 * member) never got a chance at the next rung (a fix-plan investigation via
 * selectAutoFixTargets). The guard is now widened to OR in every live target
 * of the recovery ladder the periodic pass actually drives
 * (selectMechanicalRecoveryTarget / selectResumeRecoveryTarget /
 * selectAutoFixTargets).
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — see
 * scheduler-reap-dead-running-jobs.test.cjs's comment for why.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-periodic-reverify-guard.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reverify-guard-test-'));
process.env.HOME = tmpHome;

const {
  shouldRunPeriodicReverify,
  isRescanCandidate,
  selectAutoFixTargets,
  selectMechanicalRecoveryTarget,
} = require('../scheduler.cjs');

function writeRunLog(runId, slug, lines) {
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${slug}.log`), lines.join('\n') + '\n');
}

test('a lone unverified-shaped failed row (no needs_review sibling) fires the periodic pass', () => {
  writeRunLog('run-guard-1', '4056-outcome-stats', ['[scheduler] starting 4056-outcome-stats']); // no result event
  const jobs = [
    { slug: '4059-chores-status', status: 'running', runId: 'run-guard-running' },
    {
      slug: '4056-outcome-stats',
      status: 'failed',
      runId: 'run-guard-1',
      error: 'reaped: no runtime.pid recorded after 10m — spawn never completed (outcome=no_result)',
    },
  ];
  assert.equal(isRescanCandidate(jobs[1]), true, 'fixture must be a genuine rescan candidate');
  assert.equal(shouldRunPeriodicReverify(jobs), true);
});

test('a failed row with a real result event (genuine red gate) does NOT fire the pass', () => {
  writeRunLog('run-guard-2', '200-red', [
    '[scheduler] starting 200-red',
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true }),
  ]);
  const jobs = [{ slug: '200-red', status: 'failed', runId: 'run-guard-2' }];
  assert.equal(isRescanCandidate(jobs[0]), false);
  assert.equal(shouldRunPeriodicReverify(jobs), false);
});

test('needs_review with a rescannable verdict still fires; a non-rescannable verdict does not', () => {
  writeRunLog('run-guard-3', '300-nr', ['[scheduler] starting 300-nr']);
  assert.equal(
    shouldRunPeriodicReverify([
      { slug: '300-nr', status: 'needs_review', runId: 'run-guard-3', verifierVerdict: 'verify_unavailable' },
    ]),
    true,
  );
  // A verdict outside RESCANNABLE_VERDICTS is not itself enough to suppress
  // the pass: with no sessionId, this row also fails selectResumeRecoveryTarget's
  // eligibility check, so it falls through as a genuine selectAutoFixTargets
  // candidate (a fix-plan investigation, not a rescan) — and the widened guard
  // must fire for that too.
  assert.equal(
    shouldRunPeriodicReverify([
      { slug: '300-nr', status: 'needs_review', runId: 'run-guard-3', verifierVerdict: 'uncommitted_changes' },
    ]),
    true,
  );
});

test('a needs_review row with no rescan/recovery/autofix eligibility at all does not fire the pass', () => {
  // Genuinely nothing to do: already has a fix-plan outcome recorded as
  // 'plan' (never retried by selectAutoFixTargets — see its autoFixOutcome
  // exclusion), so selectAutoFixTargets excludes it regardless of
  // fixSlugExists; not a rescan candidate (RESCANNABLE_VERDICTS); not
  // resume/mechanical eligible either.
  writeRunLog('run-guard-3b', '301-nr', ['[scheduler] starting 301-nr']);
  const jobs = [
    {
      slug: '301-nr',
      status: 'needs_review',
      runId: 'run-guard-3b',
      verifierVerdict: 'uncommitted_changes',
      autoFixAttempted: true,
      autoFixOutcome: 'plan',
    },
  ];
  assert.equal(isRescanCandidate(jobs[0]), false);
  assert.equal(selectMechanicalRecoveryTarget(jobs[0]), null);
  assert.equal(
    selectAutoFixTargets(jobs, { fixSlugExists: () => false }).length,
    0,
    'sanity: selectAutoFixTargets itself must exclude this row (cheap-guard stub matches production: fixSlugExists always false)',
  );
  assert.equal(shouldRunPeriodicReverify(jobs), false);
});

test('a queue with nothing rescannable, or a non-array, does not fire the pass', () => {
  assert.equal(shouldRunPeriodicReverify([{ slug: 'a', status: 'pending' }, { slug: 'b', status: 'completed' }]), false);
  assert.equal(shouldRunPeriodicReverify([]), false);
  assert.equal(shouldRunPeriodicReverify(undefined), false);
});

// Live reproduction fixture (verbatim, verdict from the machine 2026-09-12):
// starry-night-ships 231-saturn-record-and-docs, needs_review,
// worktree_integration_failed, mechanical recovery already spent.
function liveFixtureRow(overrides = {}) {
  return {
    slug: '231-saturn-record-and-docs',
    cwd: '/home/bilko/Projects/starry-night-ships',
    status: 'needs_review',
    verifierVerdict: 'worktree_integration_failed',
    mechanicalRecoveryAttempted: true,
    autoFixAttempted: undefined,
    runId: '2026-09-11T23-58-26-007Z',
    ...overrides,
  };
}

test('live fixture: mechanical recovery spent, autofix never attempted — guard now fires (was false)', () => {
  writeRunLog(liveFixtureRow().runId, liveFixtureRow().slug, ['[scheduler] starting 231-saturn-record-and-docs']);
  const jobs = [liveFixtureRow()];
  assert.equal(isRescanCandidate(jobs[0]), false, 'worktree_integration_failed is deliberately NOT in RESCANNABLE_VERDICTS');
  assert.equal(selectMechanicalRecoveryTarget(jobs[0]), null, 'mechanical recovery is spent (mechanicalRecoveryAttempted: true)');
  assert.equal(shouldRunPeriodicReverify(jobs), true);
});

test('live fixture is authored as a selectAutoFixTargets candidate once mechanical recovery is spent', () => {
  const jobs = [liveFixtureRow()];
  const targets = selectAutoFixTargets(jobs, { fixSlugExists: () => false });
  assert.deepEqual(targets.map((t) => t.slug), ['231-saturn-record-and-docs']);
});

test('a row whose mechanical recovery is still PENDING is excluded from selectAutoFixTargets (both rungs never fire together)', () => {
  const jobs = [liveFixtureRow({ mechanicalRecoveryAttempted: undefined })];
  assert.notEqual(selectMechanicalRecoveryTarget(jobs[0]), null, 'still eligible for its one mechanical retry');
  const targets = selectAutoFixTargets(jobs, { fixSlugExists: () => false });
  assert.deepEqual(targets, [], 'a mechanical-recovery-pending row must not also become a fix-plan target');
  // The guard still fires for this row — via the mechanical-recovery rung, not autofix.
  assert.equal(shouldRunPeriodicReverify(jobs), true);
});

test('one-attempt caps are unchanged by the widened guard', () => {
  // mechanicalRecoveryAttempted still permits exactly one retry: once true, selectMechanicalRecoveryTarget is spent forever.
  assert.equal(selectMechanicalRecoveryTarget(liveFixtureRow({ mechanicalRecoveryAttempted: true })), null);
  assert.notEqual(selectMechanicalRecoveryTarget(liveFixtureRow({ mechanicalRecoveryAttempted: undefined })), null);
  // autoFixRetries < 1 still bounds the fix-plan retry inside selectAutoFixTargets.
  const exhausted = [liveFixtureRow({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 1 })];
  assert.deepEqual(selectAutoFixTargets(exhausted, { fixSlugExists: () => false }), [], 'exhausted retry budget must stay excluded');
  const withBudget = [liveFixtureRow({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 0 })];
  assert.equal(selectAutoFixTargets(withBudget, { fixSlugExists: () => false }).length, 1, 'one bounded retry is still available');
});

test('kill-switches still fully disable their respective paths', () => {
  const jobs = [liveFixtureRow()];
  const prevAutofix = process.env.SM_AUTOFIX_DISABLE;
  const prevMechanical = process.env.SM_MECHANICAL_RECOVERY_DISABLE;
  try {
    // SM_REVERIFY_PERIODIC_DISABLE is enforced by the interval callback around
    // shouldRunPeriodicReverify (scheduler.cjs's rescheduleInterval body), not
    // inside the guard itself — the guard stays a pure predicate over jobs.
    assert.equal(process.env.SM_REVERIFY_PERIODIC_DISABLE, undefined, 'sanity: not set in this test process');

    // SM_MECHANICAL_RECOVERY_DISABLE=1 makes selectMechanicalRecoveryTarget
    // always return null, which is exactly what the widened guard consults.
    process.env.SM_MECHANICAL_RECOVERY_DISABLE = '1';
    const pendingMechanicalJob = [liveFixtureRow({ mechanicalRecoveryAttempted: undefined })];
    assert.equal(selectMechanicalRecoveryTarget(pendingMechanicalJob[0]), null);
    delete process.env.SM_MECHANICAL_RECOVERY_DISABLE;

    // SM_AUTOFIX_DISABLE gates reverifyNeedsReview's own auto-fix dispatch
    // loop (scheduler.cjs ~8207), not selectAutoFixTargets/the guard — the
    // guard's job is only to decide whether the pass should run at all, and
    // it must still fire so the disabled loop's own no-op is reached (rather
    // than the periodic pass never running and other reverify semantics,
    // e.g. rescan candidates elsewhere in the same tick, being starved too).
    process.env.SM_AUTOFIX_DISABLE = '1';
    assert.equal(shouldRunPeriodicReverify(jobs), true);
  } finally {
    if (prevAutofix === undefined) delete process.env.SM_AUTOFIX_DISABLE;
    else process.env.SM_AUTOFIX_DISABLE = prevAutofix;
    if (prevMechanical === undefined) delete process.env.SM_MECHANICAL_RECOVERY_DISABLE;
    else process.env.SM_MECHANICAL_RECOVERY_DISABLE = prevMechanical;
  }
});
