/**
 * scheduler-default-eligible-heal.test.cjs — the periodic heal ladder is
 * default-ELIGIBLE (2026-09-18, 1229-fo-03 parked shared_tree_reverted and
 * blocked 19 of 20 pending rows because that verdict was on no allow-list).
 *
 * Covers: any needs_review verdict is a candidate unless named in
 * RESCAN_EXCLUDED_VERDICTS; the evidence rung is bounded; a row that cannot
 * heal terminates under the bounded ladder; health names a silent blocker.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-default-eligible-heal.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'default-eligible-heal-test-'));

const {
  isRescanCandidate,
  isTranscriptRescannable,
  isStrandedAutoFixPark,
  isEligibleForNeedsReviewAutoResolve,
  shouldRunPeriodicReverify,
  selectEvidenceScanTargets,
  selectAutoFixTargets,
  selectMechanicalRecoveryTarget,
  selectResumeRecoveryTarget,
  applyNeedsReviewAutoResolve,
  RESCAN_EXCLUDED_VERDICTS,
  RESCANNABLE_VERDICTS,
  EVIDENCE_SCAN_MAX_PER_PASS,
  EVIDENCE_SCAN_MIN_INTERVAL_MS,
  REVERIFY_INTERVAL_MS,
  NEEDS_REVIEW_RESOLVE_CAP,
} = require('../scheduler.cjs');
const { evaluateBlockingParkHealth } = require('../health.cjs');

const row = (o = {}) => ({ slug: '10-x', status: 'needs_review', runId: 'r1', cwd: '/p', ...o });

test('shared_tree_reverted is a rescan candidate without being on any list', () => {
  assert.equal(RESCANNABLE_VERDICTS.has('shared_tree_reverted'), false);
  assert.equal(isRescanCandidate(row({ verifierVerdict: 'shared_tree_reverted' })), true);
});

test('an invented verdict name the code has never seen is a rescan candidate', () => {
  const j = row({ verifierVerdict: 'some_future_guard_verdict' });
  assert.equal(isRescanCandidate(j), true);
  assert.equal(shouldRunPeriodicReverify([j]), true);
  // Not transcript-rescannable: it gets the evidence rung, never a verifyRun heal.
  assert.equal(isTranscriptRescannable(j), false);
  assert.deepEqual(selectEvidenceScanTargets([j]).map((x) => x.slug), ['10-x']);
});

test('a needs_review row with no runId and no verdict is still a candidate', () => {
  assert.equal(isRescanCandidate({ slug: 's', status: 'needs_review' }), true);
});

test('only the named exclusions are refused, each verdict in the set', () => {
  for (const v of RESCAN_EXCLUDED_VERDICTS) assert.equal(isRescanCandidate(row({ verifierVerdict: v })), false, v);
  assert.deepEqual([...RESCAN_EXCLUDED_VERDICTS].sort(), ['budget_exceeded', 'uncommitted_changes', 'worktree_integration_failed']);
});

test('rescannable verdict keeps the transcript rung as a hint', () => {
  assert.equal(isTranscriptRescannable(row({ verifierVerdict: 'transcript_errors' })), true);
  assert.deepEqual(selectEvidenceScanTargets([row({ verifierVerdict: 'transcript_errors' })]), []);
});

test('1229-fo-03 shape: stranded auto-fix park is an auto-resolve door AND an evidence-scan target', () => {
  const j = row({ verifierVerdict: 'shared_tree_reverted', autoFixAttempted: true });
  assert.equal(isStrandedAutoFixPark(j, [j]), true);
  assert.equal(isEligibleForNeedsReviewAutoResolve(j, [j]), true);
  assert.equal(selectEvidenceScanTargets([j]).length, 1, 'looksDone evidence is now computed for it, so the door can fire');
});

test('a live auto-fix history that is not an auto-resolve door gets no evidence scan (PRD 1136)', () => {
  const j = row({ verifierVerdict: 'some_future_guard_verdict', autoFixAttempted: true, autoFixOutcome: 'plan' });
  assert.equal(selectEvidenceScanTargets([j]).length, 0);
});

test('cost bound: per-pass cap, looksDone skip, and per-row re-scan throttle', () => {
  const now = Date.now();
  const many = Array.from({ length: 100 }, (_, i) => row({ slug: `${i}-p`, verifierVerdict: 'v_new' }));
  assert.equal(selectEvidenceScanTargets(many, now).length, EVIDENCE_SCAN_MAX_PER_PASS);
  const done = many.map((j) => ({ ...j, looksDone: { commits: ['a'] } }));
  assert.equal(selectEvidenceScanTargets(done, now).length, 0);
  const fresh = many.map((j) => ({ ...j, evidenceScannedAt: new Date(now - EVIDENCE_SCAN_MIN_INTERVAL_MS + 1000).toISOString() }));
  assert.equal(selectEvidenceScanTargets(fresh, now).length, 0);
  // never-scanned rows go before stale-scanned ones
  const mixed = [
    row({ slug: 'old', verifierVerdict: 'v', evidenceScannedAt: new Date(now - 10 * EVIDENCE_SCAN_MIN_INTERVAL_MS).toISOString() }),
    row({ slug: 'never', verifierVerdict: 'v' }),
  ];
  assert.equal(selectEvidenceScanTargets(mixed, now)[0].slug, 'never');
});

test('unhealable row terminates: N passes yield a bounded number of recovery attempts, reason intact', () => {
  let now = Date.now();
  const job = row({ slug: '20-stuck', verifierVerdict: 'some_future_guard_verdict' });
  const jobs = [job];
  let evidenceScans = 0;
  let autoFixDispatches = 0;
  let resumeOrMechanical = 0;
  const PASSES = 500;
  for (let n = 0; n < PASSES; n++) {
    now += REVERIFY_INTERVAL_MS;
    for (const t of selectEvidenceScanTargets(jobs, now)) { evidenceScans++; t.evidenceScannedAt = new Date(now).toISOString(); }
    resumeOrMechanical += jobs.filter((j) => selectMechanicalRecoveryTarget(j) || selectResumeRecoveryTarget(j)).length;
    for (const t of selectAutoFixTargets(jobs, { fixSlugExists: () => false, resolveJobRunId: () => 'r1' })) {
      autoFixDispatches++;
      // what reverifyNeedsReview stamps before spawning
      t.autoFixRetries = t.autoFixAttempted === true ? (t.autoFixRetries ?? 0) + 1 : t.autoFixRetries;
      t.autoFixAttempted = true;
    }
  }
  assert.ok(autoFixDispatches <= 2, `auto-fix dispatched ${autoFixDispatches}x`);
  assert.equal(resumeOrMechanical, 0);
  // one scan per throttle window, not one per pass
  assert.ok(evidenceScans <= Math.ceil(PASSES * REVERIFY_INTERVAL_MS / EVIDENCE_SCAN_MIN_INTERVAL_MS), `evidence scans ${evidenceScans}`);
  assert.ok(evidenceScans < PASSES / 2);
  assert.equal(job.status, 'needs_review');
  assert.equal(job.verifierVerdict, 'some_future_guard_verdict');
});

test('auto-resolve ladder is capped: requeue attempts stop at NEEDS_REVIEW_RESOLVE_CAP then skip', () => {
  const j = row({ slug: '30-cap', verifierVerdict: 'x', autoFixAttempted: true });
  const outcomes = [];
  for (let i = 0; i < NEEDS_REVIEW_RESOLVE_CAP + 3; i++) {
    const o = applyNeedsReviewAutoResolve(j, [j]);
    if (!o) break;
    outcomes.push(o);
    if (o === 'requeued') j.status = 'needs_review';
    if (o === 'skipped') break;
  }
  assert.equal(outcomes.filter((o) => o === 'requeued').length, NEEDS_REVIEW_RESOLVE_CAP);
  assert.equal(outcomes.at(-1), 'skipped');
});

describe('evaluateBlockingParkHealth', () => {
  const now = Date.parse('2026-09-18T20:00:00Z');
  const parkedAgo = (ms) => [{ to: 'needs_review', at: new Date(now - ms).toISOString() }];
  const park = (ms, o = {}) => ({ slug: '5-park', status: 'needs_review', cwd: '/p', verifierVerdict: 'shared_tree_reverted', statusHistory: parkedAgo(ms), ...o });
  const dep = (slug, dependsOn) => ({ slug, status: 'pending', cwd: '/p', dependsOn });

  test('parked past one interval with pending dependents (transitive) is non-green, naming row + count', () => {
    const r = evaluateBlockingParkHealth([park(REVERIFY_INTERVAL_MS + 1000), dep('6-a', ['5-park']), dep('7-b', ['6-a']), dep('8-c', [])], now);
    assert.equal(r.ok, false);
    assert.equal(r.parks[0].slug, '5-park');
    assert.equal(r.parks[0].dependents, 2);
    assert.match(r.message, /5-park/);
    assert.match(r.message, /blocking 2 pending dependent/);
  });

  test('young park, or park with no dependents, is healthy', () => {
    assert.equal(evaluateBlockingParkHealth([park(1000), dep('6-a', ['5-park'])], now).ok, true);
    assert.equal(evaluateBlockingParkHealth([park(REVERIFY_INTERVAL_MS * 5), dep('6-a', [])], now).ok, true);
  });
});
