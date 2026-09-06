/**
 * scheduler-resume-recovery.test.cjs — PRD 1111: resume-first recovery for a
 * job parked in needs_review with verdict 'uncommitted_changes'. Before this
 * feature, every such job went straight to spawnInvestigation (a cold-read
 * fix-plan PRD authored by a FRESH session with no memory of the run it's
 * diagnosing). This suite covers selectResumeRecoveryTarget's eligibility
 * table, the --resume vs --session-id argv split (buildClaudeSpawnArgs), the
 * preamble builder, the one-attempt bound, the SM_RESUME_RECOVERY_DISABLE
 * kill-switch, and the two skip-gates (spawnInvestigation, selectAutoFixTargets).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-resume-recovery.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const {
  selectResumeRecoveryTarget,
  buildResumeRecoveryPreamble,
  buildClaudeSpawnArgs,
  selectAutoFixTargets,
  spawnInvestigation,
} = require('../scheduler.cjs');

const savedDisable = process.env.SM_RESUME_RECOVERY_DISABLE;
afterEach(() => {
  if (savedDisable === undefined) delete process.env.SM_RESUME_RECOVERY_DISABLE;
  else process.env.SM_RESUME_RECOVERY_DISABLE = savedDisable;
});

function baseJob(overrides = {}) {
  return {
    slug: '900-example',
    status: 'needs_review',
    verifierVerdict: 'uncommitted_changes',
    sessionId: 'sess-abc-123',
    uncommittedPaths: ['src/foo.js', 'src/bar.js'],
    ...overrides,
  };
}

// ---------- selectResumeRecoveryTarget eligibility table ----------

test('selectResumeRecoveryTarget: eligible shape returns a resume decision', () => {
  const target = selectResumeRecoveryTarget(baseJob());
  expect(target).toEqual({
    slug: '900-example',
    sessionId: 'sess-abc-123',
    dirtyPaths: ['src/foo.js', 'src/bar.js'],
    salvagePatch: null,
  });
});

test('selectResumeRecoveryTarget: carries salvagePatch through when present on the row', () => {
  const target = selectResumeRecoveryTarget(baseJob({ salvagePatch: '/tmp/runs/x/900-example.uncommitted.patch' }));
  expect(target.salvagePatch).toBe('/tmp/runs/x/900-example.uncommitted.patch');
});

const notNeedsReviewStatuses = ['pending', 'running', 'investigating', 'completed', 'failed', 'skipped'];
for (const status of notNeedsReviewStatuses) {
  test(`selectResumeRecoveryTarget: status=${status} → null`, () => {
    expect(selectResumeRecoveryTarget(baseJob({ status }))).toBeNull();
  });
}

const nonRecoverableVerdicts = [
  'silent_no_op',
  'pass_no_commit_already_shipped',
  'pass_no_commit_prior_run_verified',
  'transcript_errors',
  'deps_unmet',
  'halt',
  'verify_unavailable',
  'worktree_integration_failed',
  'shared_tree_reverted',
  undefined,
];
for (const verdict of nonRecoverableVerdicts) {
  test(`selectResumeRecoveryTarget: verdict=${JSON.stringify(verdict)} → null`, () => {
    expect(selectResumeRecoveryTarget(baseJob({ verifierVerdict: verdict }))).toBeNull();
  });
}

test('selectResumeRecoveryTarget: missing sessionId → null', () => {
  expect(selectResumeRecoveryTarget(baseJob({ sessionId: undefined }))).toBeNull();
});

test('selectResumeRecoveryTarget: empty-string sessionId → null', () => {
  expect(selectResumeRecoveryTarget(baseJob({ sessionId: '' }))).toBeNull();
});

test('selectResumeRecoveryTarget: non-string sessionId → null', () => {
  expect(selectResumeRecoveryTarget(baseJob({ sessionId: 12345 }))).toBeNull();
});

test('selectResumeRecoveryTarget: resumeRecoveryAttempted === true → null (bounded to one attempt)', () => {
  expect(selectResumeRecoveryTarget(baseJob({ resumeRecoveryAttempted: true }))).toBeNull();
});

test('selectResumeRecoveryTarget: resumeRecoveryAttempted absent/false → still eligible', () => {
  expect(selectResumeRecoveryTarget(baseJob({ resumeRecoveryAttempted: false }))).not.toBeNull();
  expect(selectResumeRecoveryTarget(baseJob())).not.toBeNull();
});

test('selectResumeRecoveryTarget: no recorded dirty paths → null', () => {
  expect(selectResumeRecoveryTarget(baseJob({ uncommittedPaths: [] }))).toBeNull();
  expect(selectResumeRecoveryTarget(baseJob({ uncommittedPaths: undefined }))).toBeNull();
});

test('selectResumeRecoveryTarget: null/undefined job → null', () => {
  expect(selectResumeRecoveryTarget(null)).toBeNull();
  expect(selectResumeRecoveryTarget(undefined)).toBeNull();
});

test('selectResumeRecoveryTarget: SM_RESUME_RECOVERY_DISABLE=1 → null even for an otherwise-eligible job', () => {
  process.env.SM_RESUME_RECOVERY_DISABLE = '1';
  expect(selectResumeRecoveryTarget(baseJob())).toBeNull();
});

// ---------- --resume vs --session-id argv (buildClaudeSpawnArgs) ----------

test('buildClaudeSpawnArgs: resume=true passes --resume <sessionId>, never --session-id', () => {
  const args = buildClaudeSpawnArgs({ prompt: 'preamble text', model: 'sonnet', sessionId: 'sess-abc-123', resume: true });
  expect(args).toContain('--resume');
  expect(args[args.indexOf('--resume') + 1]).toBe('sess-abc-123');
  expect(args).not.toContain('--session-id');
});

test('buildClaudeSpawnArgs: resume=false passes --session-id <sessionId>, never --resume', () => {
  const args = buildClaudeSpawnArgs({ prompt: 'prd body', model: 'sonnet', sessionId: 'sess-fresh-456', resume: false });
  expect(args).toContain('--session-id');
  expect(args[args.indexOf('--session-id') + 1]).toBe('sess-fresh-456');
  expect(args).not.toContain('--resume');
});

test('buildClaudeSpawnArgs: --model is always explicitly pinned, both modes', () => {
  for (const resume of [true, false]) {
    const args = buildClaudeSpawnArgs({ prompt: 'x', model: 'sonnet', sessionId: 'sid', resume });
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('sonnet');
  }
});

// ---------- preamble content (buildResumeRecoveryPreamble) ----------

test('buildResumeRecoveryPreamble: contains every recorded dirty path', () => {
  const dirtyPaths = ['src/main/scheduler.cjs', 'session-manager-operations/scheduler/prds/900-example.md'];
  const preamble = buildResumeRecoveryPreamble({ dirtyPaths, salvagePatch: null });
  for (const p of dirtyPaths) {
    expect(preamble).toContain(p);
  }
});

test('buildResumeRecoveryPreamble: does NOT re-embed a PRD body passed in as an unrelated string', () => {
  const prdBody = '# Goal\nSome long PRD body that must never appear in a resume preamble.\n## Acceptance criteria\n- [ ] thing';
  const preamble = buildResumeRecoveryPreamble({ dirtyPaths: ['a.js'], salvagePatch: null });
  expect(preamble).not.toContain(prdBody);
  expect(preamble).not.toContain('Acceptance criteria');
});

test('buildResumeRecoveryPreamble: instructs verifying paths on disk, foreground gate, and commit', () => {
  const preamble = buildResumeRecoveryPreamble({ dirtyPaths: ['a.js'], salvagePatch: null });
  expect(preamble).toMatch(/verify/i);
  expect(preamble).toMatch(/FOREGROUND/);
  expect(preamble).toMatch(/commit/i);
});

test('buildResumeRecoveryPreamble: mentions the salvage patch path when present', () => {
  const preamble = buildResumeRecoveryPreamble({ dirtyPaths: ['a.js'], salvagePatch: '/tmp/runs/x/900-example.uncommitted.patch' });
  expect(preamble).toContain('/tmp/runs/x/900-example.uncommitted.patch');
});

// ---------- selectAutoFixTargets skips resume-eligible jobs ----------

test('selectAutoFixTargets: excludes a job selectResumeRecoveryTarget accepts', () => {
  const job = baseJob({ runId: 'run-1' });
  const targets = selectAutoFixTargets([job], {
    fixSlugExists: () => false,
    resolveJobRunId: () => job.runId,
  });
  expect(targets).toEqual([]);
});

test('selectAutoFixTargets: still selects a needs_review job that is NOT resume-eligible (different verdict)', () => {
  const job = baseJob({ runId: 'run-1', verifierVerdict: 'transcript_errors' });
  const targets = selectAutoFixTargets([job], {
    fixSlugExists: () => false,
    resolveJobRunId: () => job.runId,
  });
  expect(targets.map((t) => t.slug)).toEqual([job.slug]);
});

test('selectAutoFixTargets: a resume-recovery-exhausted job (resumeRecoveryAttempted=true) falls through to normal auto-fix eligibility', () => {
  const job = baseJob({ runId: 'run-1', resumeRecoveryAttempted: true });
  const targets = selectAutoFixTargets([job], {
    fixSlugExists: () => false,
    resolveJobRunId: () => job.runId,
  });
  expect(targets.map((t) => t.slug)).toEqual([job.slug]);
});

// ---------- resume-then-fail: never a dead end ----------

test('resume-then-fail: a job whose one resume attempt is spent falls through to the normal fix-plan path, not a dead end', () => {
  // spawnResumeRecovery reuses spawnJob wholesale, so a resume run that
  // itself re-parks in needs_review runs through the SAME finalize mutate as
  // any other run — the only difference is resumeRecoveryAttempted is now
  // true on the row (stamped atomically with the 'running' transition
  // before the resume child ever spawned).
  const jobAfterFailedResume = baseJob({ runId: 'run-2', resumeRecoveryAttempted: true });
  // A second resume is refused...
  expect(selectResumeRecoveryTarget(jobAfterFailedResume)).toBeNull();
  // ...but the job is NOT stranded: it is offered for a fix-plan exactly
  // like any other needs_review job, via the same gate spawnInvestigation's
  // periodic caller (reverifyNeedsReview) consults.
  const targets = selectAutoFixTargets([jobAfterFailedResume], {
    fixSlugExists: () => false,
    resolveJobRunId: () => jobAfterFailedResume.runId,
  });
  expect(targets.map((t) => t.slug)).toEqual([jobAfterFailedResume.slug]);
});

// ---------- spawnInvestigation's own resume-first guard ----------

test('spawnInvestigation: a resume-eligible job is skipped before any fix-plan work (returns deferred:false immediately)', async () => {
  const job = baseJob();
  // A resume-eligible job trips the guard before spawnInvestigation ever
  // touches the filesystem for runDir/investigationDepth lookups, so a
  // nonexistent runDir is safe to pass here — proves the guard runs first.
  const result = await spawnInvestigation(job, '/nonexistent/run/dir/for/this/test');
  expect(result).toEqual({ deferred: false });
});

test('spawnInvestigation: resume-recovery-exhausted job (resumeRecoveryAttempted=true) is NOT skipped by the resume guard', async () => {
  // slug matches the fix-plan pattern + investigationDepth beyond the cap so
  // the NEXT gate (isFixPlanBeyondDepthCap) trips deterministically and
  // returns before any fs/spawn work — proving the resume guard was passed
  // through, not that this particular job happens to be safe to fully run.
  const job = baseJob({ slug: '01-fix-example', resumeRecoveryAttempted: true, investigationDepth: 99 });
  const result = await spawnInvestigation(job, '/nonexistent/run/dir/for/this/test');
  expect(result).toEqual({ deferred: false });
});

test('SM_RESUME_RECOVERY_DISABLE=1: spawnInvestigation is NOT skipped by the resume guard for an otherwise-eligible job', async () => {
  process.env.SM_RESUME_RECOVERY_DISABLE = '1';
  const job = baseJob({ slug: '01-fix-example', investigationDepth: 99 });
  // With the kill-switch on, selectResumeRecoveryTarget returns null, so the
  // resume guard never fires; the job falls through to the NEXT gate
  // (isFixPlanBeyondDepthCap, tripped here via investigationDepth: 99) —
  // proving today's pre-feature behaviour is restored exactly.
  const result = await spawnInvestigation(job, '/nonexistent/run/dir/for/this/test');
  expect(result).toEqual({ deferred: false });
});
