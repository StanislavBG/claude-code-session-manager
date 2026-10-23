// Dispatch (pickForProject/findBlockingDep) and post-run verify (runVerify.checkDeps)
// must agree on every dep-row status. When they disagreed on a
// needsReviewAutoResolvedSkip row, the picker fired the dependent, verify
// downgraded the finished run to pending ("is skipped (need completed)"), and
// the validator re-ran ~20 times (Bilko-Launch-Kit, 2026-10-11).
import { test, expect } from 'vitest';
const { pickForProject, findBlockingDep } = require('../schedulerBatch.cjs');
const { checkDeps } = require('../../../runVerify.cjs');

const CWD = '/tmp/dep-gate-agreement';
const validator = (status) => ({ slug: '6-validate-no-source-disclosure', status, cwd: CWD, dependsOn: ['site-value-first-copy'] });
const autoSkipped = {
  slug: '5-site-value-first-copy', status: 'skipped', cwd: CWD, needsReviewAutoResolvedSkip: true,
  error: 'needs_review auto-resolve: exhausted auto-fix path — auto-skipped to unblock downstream dependsOn rows',
};
const fixPlan = { slug: '05-fix-site-value-first-copy', status: 'completed', cwd: CWD };

test('auto-resolve skip: dispatched once, and the finished run is NOT downgraded (no loop)', () => {
  const pending = [autoSkipped, fixPlan, validator('pending')];
  expect(pickForProject(pending, new Set(), 4).batch.map((j) => j.slug)).toEqual(['6-validate-no-source-disclosure']);

  const finished = [autoSkipped, fixPlan, validator('running')];
  expect(checkDeps(finished[2], finished)).toEqual({ ok: true });
});

test('plain skip (PRD source gone): held at dispatch, so it runs zero times', () => {
  const plainSkip = { ...autoSkipped, needsReviewAutoResolvedSkip: undefined, error: 'PRD source vanished' };
  const jobs = [plainSkip, validator('pending')];
  const { batch, reason } = pickForProject(jobs, new Set(), 4);
  expect(batch).toEqual([]);
  expect(reason).toMatch(/never-ran dependencies/);
  expect(checkDeps(jobs[1], jobs).ok).toBe(false);
});

test.each(['completed', 'pending', 'running', 'failed', 'needs_review', 'skipped'])(
  'dispatch and verify agree for a dep row in status %s',
  (status) => {
    for (const marker of [true, undefined]) {
      const dep = { slug: '5-site-value-first-copy', status, cwd: CWD, needsReviewAutoResolvedSkip: marker };
      const jobs = [dep, validator('pending')];
      const blocked = findBlockingDep(jobs[1], jobs) !== undefined;
      expect(checkDeps(jobs[1], jobs).ok).toBe(!blocked);
    }
  },
);

test('prose "Depends on:" in a PRD body is not a dependency signal', () => {
  const pendingJob = { slug: '150-surface-motion-perf-and-docs', status: 'pending', cwd: CWD };
  const entry = { slug: '133-enemy-crew-body-adoption', status: 'running', cwd: CWD, dependsOn: [] };
  // checkDeps takes no PRD body: the body "Depends on:\n- do the thing" cannot reach it.
  expect(checkDeps(entry, [pendingJob, entry])).toEqual({ ok: true });
});

test('unmet explicit dependsOn still blocks with "(need completed)"', () => {
  const dep = { slug: '150-surface-motion-perf-and-docs', status: 'pending', cwd: CWD };
  const entry = { slug: '133-enemy-crew-body-adoption', status: 'running', cwd: CWD, dependsOn: ['surface-motion-perf-and-docs'] };
  const r = checkDeps(entry, [dep, entry]);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain('(need completed)');
});
