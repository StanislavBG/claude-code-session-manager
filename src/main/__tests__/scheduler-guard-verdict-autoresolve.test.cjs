/**
 * scheduler-guard-verdict-autoresolve.test.cjs — needs_review ladder gap
 * (2026-09-12, PRD 1181 shape).
 *
 * Auto-fix investigations only ever launch for FAILING runs — a job that
 * exits 0 and gets parked by a post-run GUARD verdict (commit-guard
 * 'silent_no_op', shared-tree-guard 'shared_tree_reverted') never has
 * job.autoFixAttempted set, so isExhaustedAutoFix(job) is false forever and
 * the row is invisible to the existing needs_review auto-resolve ladder —
 * it sits in needs_review permanently, blocking every dependsOn row behind
 * it, until a human clears it by hand. PRD 1181 proved it: exit 0, commit
 * aff5607 landed, parked on a guard verdict, needed a human.
 *
 * This file covers the widened entry gate (isGuardParkedWithoutAutoFix /
 * isEligibleForNeedsReviewAutoResolve) that admits these rows to the SAME
 * ladder (selectExhaustedNeedsReviewTargets / applyNeedsReviewAutoResolve)
 * the exhausted-auto-fix path already uses, keyed on landedCommit +
 * looksDone evidence instead of a spent auto-fix attempt — and the closed
 * set of verdicts eligible for this (GUARD_VERDICT_EVIDENCE_ELIGIBLE)
 * excludes 'worktree_integration_failed', whose damage IS a commit (one
 * stranded on an unmerged branch), so a landedCommit there is not evidence
 * against the verdict.
 *
 * scheduler-needs-review-autoresolve.test.cjs's own suite covers the
 * pre-existing exhausted-auto-fix ladder and must keep passing UNCHANGED —
 * this file only adds new coverage for the second door into the same ladder.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — same
 * reason as scheduler-needs-review-autoresolve.test.cjs (appendAuditEvent
 * writes under $HOME/.claude/session-manager/audit-log.jsonl).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-guard-verdict-autoresolve.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-verdict-autoresolve-test-'));
process.env.HOME = tmpHome;

const { execFileSync } = require('node:child_process');

const {
  selectExhaustedNeedsReviewTargets,
  applyNeedsReviewAutoResolve,
  NEEDS_REVIEW_RESOLVE_CAP,
  GUARD_VERDICT_EVIDENCE_ELIGIBLE,
  isGuardParkedWithoutAutoFix,
  isEligibleForNeedsReviewAutoResolve,
  isExhaustedAutoFix,
  reverifyNeedsReview,
} = require('../scheduler.cjs');

const { pickForProject } = require('../lib/schedulerBatch.cjs');
const { resolvePrdWriteDir } = require('../lib/prdLocations.cjs');
const { bustCwdCache } = require('../lib/queueStore.cjs');

const MIN_MS = 60_000;
const THRESHOLD_MS = 30 * MIN_MS;

function guardParkedJob(overrides = {}) {
  return {
    slug: '1181-guard-parked-row',
    cwd: '/home/user/project',
    status: 'needs_review',
    exitCode: 0,
    verifierVerdict: 'silent_no_op',
    landedCommit: 'aff5607abc123',
    statusHistory: [{ to: 'needs_review', at: new Date(Date.now() - 45 * MIN_MS).toISOString() }],
    ...overrides,
  };
}

// --- enumeration: which guard verdicts are eligible ---

test('GUARD_VERDICT_EVIDENCE_ELIGIBLE contains exactly the benign guard verdicts, never worktree_integration_failed', () => {
  assert.ok(GUARD_VERDICT_EVIDENCE_ELIGIBLE.has('silent_no_op'));
  assert.ok(GUARD_VERDICT_EVIDENCE_ELIGIBLE.has('shared_tree_reverted'));
  assert.equal(GUARD_VERDICT_EVIDENCE_ELIGIBLE.has('worktree_integration_failed'), false);
});

// reaperHelpers.resolvePidlessFailureOverride parks a pidless reap on this
// exact verdict when the row already carries a landedCommit — same shape as
// silent_no_op/shared_tree_reverted (exit never observed, no autoFixAttempted,
// real commit evidence), so it must share this ladder too, or a pidless-reap
// row stalls in needs_review with nothing to spend and nothing to exhaust —
// the same bug this file's other tests exist to prevent for the other two
// verdicts.
test('GUARD_VERDICT_EVIDENCE_ELIGIBLE also contains pidless_reap_with_landed_commit', () => {
  assert.ok(GUARD_VERDICT_EVIDENCE_ELIGIBLE.has('pidless_reap_with_landed_commit'));
});

// --- isGuardParkedWithoutAutoFix / isEligibleForNeedsReviewAutoResolve ---

test('a guard-verdict park with no auto-fix history is guard-parked-without-autofix', () => {
  const job = guardParkedJob();
  assert.equal(isGuardParkedWithoutAutoFix(job), true);
  assert.equal(isExhaustedAutoFix(job), false, 'never went through auto-fix — must not double-count as exhausted');
  assert.equal(isEligibleForNeedsReviewAutoResolve(job), true);
});

test('a row that DID get an auto-fix investigation is left to the exhausted-auto-fix door, not this one', () => {
  const job = guardParkedJob({ autoFixAttempted: true, autoFixOutcome: 'no-plan', autoFixRetries: 1 });
  assert.equal(isGuardParkedWithoutAutoFix(job), false);
  assert.equal(isExhaustedAutoFix(job), true);
  assert.equal(isEligibleForNeedsReviewAutoResolve(job), true, 'still eligible overall, via the OTHER door');
});

test('(c) worktree_integration_failed is never guard-parked-without-autofix, whatever evidence it carries', () => {
  const job = guardParkedJob({ verifierVerdict: 'worktree_integration_failed' });
  assert.equal(isGuardParkedWithoutAutoFix(job), false);
  assert.equal(isEligibleForNeedsReviewAutoResolve(job), false);
});

test('a needs_review row with an unrecognized verifierVerdict and no auto-fix history is not eligible', () => {
  const job = guardParkedJob({ verifierVerdict: 'transcript_errors' });
  assert.equal(isGuardParkedWithoutAutoFix(job), false);
  assert.equal(isEligibleForNeedsReviewAutoResolve(job), false);
});

// --- selectExhaustedNeedsReviewTargets: the widened selector ---

test('a fresh guard-parked row (under threshold) is not selected', () => {
  const job = guardParkedJob({
    statusHistory: [{ to: 'needs_review', at: new Date(Date.now() - 2 * MIN_MS).toISOString() }],
  });
  assert.equal(selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('a guard-parked row past threshold, under the cap, is selected', () => {
  const job = guardParkedJob();
  const found = selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS);
  assert.equal(found.length, 1);
  assert.equal(found[0].slug, '1181-guard-parked-row');
});

test('(c) worktree_integration_failed is never selected, even past threshold with a landedCommit', () => {
  const job = guardParkedJob({ verifierVerdict: 'worktree_integration_failed' });
  assert.equal(selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

// --- applyNeedsReviewAutoResolve: the three-branch policy, entered via the guard door ---

test('(a) the 1181 shape — exit 0 + guard verdict + landedCommit + looksDone — auto-completes', () => {
  const job = guardParkedJob({
    looksDone: { commits: ['aff5607'], paths: ['src/main/scheduler.cjs'], detectedAt: new Date().toISOString() },
  });
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'completed');
  assert.equal(job.status, 'completed');
  assert.match(job.statusHistory.at(-1).reason, /silent_no_op/, 'the reason must name the evidence, not just "auto-resolved"');
});

test('(b) the same shape WITHOUT looksDone does not auto-complete on the first pass — bounded requeue instead', () => {
  const job = guardParkedJob({ exhaustedResolveAttempts: 0 });
  assert.equal(job.looksDone, undefined);
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'requeued');
  assert.equal(job.status, 'pending');
  assert.equal(job.exhaustedResolveAttempts, 1);
  assert.match(job.statusHistory.at(-1).reason, /silent_no_op/);
});

test('a guard-parked row with no evidence, cap spent, auto-skips with the guard verdict named in job.error', () => {
  const job = guardParkedJob({ exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP });
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'skipped');
  assert.equal(job.status, 'skipped');
  assert.equal(job.needsReviewAutoResolvedSkip, true);
  assert.match(job.error, /silent_no_op/, 'a human reading the queue must see WHY, not a generic auto-resolved label');
  assert.doesNotMatch(job.error, /exhausted auto-fix path/, 'this row never went through auto-fix — must not claim it did');
});

test('(c) worktree_integration_failed never auto-completes on landed-commit + looksDone evidence', () => {
  const job = guardParkedJob({
    verifierVerdict: 'worktree_integration_failed',
    looksDone: { commits: ['aff5607'], paths: ['src/main/scheduler.cjs'], detectedAt: new Date().toISOString() },
  });
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, null, 'this verdict has no door into this ladder at all');
  assert.equal(job.status, 'needs_review', 'must stay parked — its own mechanical-recovery path owns this verdict, not this ladder');
});

test('the pre-existing exhausted-auto-fix ladder is unaffected: same branch, same cap, same audit shape', () => {
  const job = {
    slug: 'exhausted-row',
    cwd: '/home/user/project',
    status: 'needs_review',
    autoFixAttempted: true,
    autoFixOutcome: 'no-plan',
    autoFixRetries: 1,
    exhaustedResolveAttempts: 1,
    looksDone: { commits: ['abc1234'], paths: ['src/main/scheduler.cjs'], detectedAt: new Date().toISOString() },
  };
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'completed');
  assert.match(job.statusHistory.at(-1).reason, /verifier annotation shows work landed/);
});

// --- (d) chain drain: a downstream dependsOn row becomes eligible once the guard-parked blocker resolves ---

test('(d) a dependsOn chain drains once a guard-parked blocker (no auto-fix, no evidence, cap spent) auto-skips', () => {
  const now = Date.now();
  const rowA = { slug: 'a-first', cwd: '/home/user/project', status: 'completed' };
  const rowB = guardParkedJob({
    slug: 'b-middle',
    exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP,
    dependsOn: ['a-first'],
  });
  const rowC = { slug: 'c-last', cwd: '/home/user/project', status: 'pending', dependsOn: ['b-middle'] };
  const jobs = [rowA, rowB, rowC];

  const before = pickForProject(jobs, new Set(), 5);
  assert.equal(before.batch.length, 0, 'C must not be eligible while B still sits in needs_review');

  const targets = selectExhaustedNeedsReviewTargets(jobs, now, THRESHOLD_MS);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].slug, 'b-middle');
  const outcome = applyNeedsReviewAutoResolve(rowB);
  assert.equal(outcome, 'skipped');

  const after = pickForProject(jobs, new Set(), 5);
  assert.ok(after.batch.some((j) => j.slug === 'c-last'), 'C must become eligible once B is auto-skipped');
});

// --- end-to-end: reverifyNeedsReview computes looksDone for a guard-parked row ---

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function commitFile(dir, relPath, content, message) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(['add', relPath], dir);
  git(['commit', '-q', '-m', message], dir);
}

function registerActiveProject(cwd, slug) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', slug);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

function writePrd(cwd, slug, body) {
  const dir = resolvePrdWriteDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: Test PRD\ncwd: ${cwd}\nestimateMinutes: 30\n---\n${body}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), text);
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

test('reverifyNeedsReview computes looksDone for a guard-parked (silent_no_op) row with no auto-fix history', async () => {
  const projectCwd = path.join(tmpHome, 'proj-guard-parked');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-guard-parked-slug');
  writePrd(projectCwd, '1181-guard-parked', [
    '# Implementation notes',
    'Edit `src/thing.js`.',
  ].join('\n'));

  const startedAt = new Date().toISOString();
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: '1181-guard-parked',
      status: 'needs_review',
      cwd: projectCwd,
      runId: 'run-1181',
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      verifierVerdict: 'silent_no_op',
      landedCommit: 'deadbeef',
      error: 'commit-guard: made no commit on an already-clean tree',
    },
  ]);

  await wait(1100); // git --since has 1s resolution
  // Must be attributable to THIS job (see attributeLandedCommits) — path
  // overlap alone is no longer evidence. The row's own `landedCommit`
  // ('deadbeef') is a stale/unresolvable placeholder, so this falls to the
  // 'slug trailer' rule by naming the job's own slug in the commit message.
  commitFile(projectCwd, 'src/thing.js', 'hello', 'the actual fix for 1181-guard-parked landed');

  await reverifyNeedsReview();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'needs_review', 'looksDone alone never auto-completes — only applyNeedsReviewAutoResolve does');
  assert.ok(jobs[0].looksDone, 'expected a looksDone annotation computed for this guard-parked row');
  assert.equal(jobs[0].looksDone.commits.length, 1);
  assert.equal(jobs[0].looksDone.rule, 'slug trailer');
});

test('reverifyNeedsReview never computes looksDone for a worktree_integration_failed row', async () => {
  const projectCwd = path.join(tmpHome, 'proj-stranded-branch');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-stranded-branch-slug');
  writePrd(projectCwd, '1181-stranded', [
    '# Implementation notes',
    'Edit `src/thing.js`.',
  ].join('\n'));

  const startedAt = new Date().toISOString();
  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: '1181-stranded',
      status: 'needs_review',
      cwd: projectCwd,
      runId: 'run-stranded',
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      verifierVerdict: 'worktree_integration_failed',
      landedCommit: 'deadbeef',
      error: 'worktree branch integration failed',
    },
  ]);

  await wait(1100);
  commitFile(projectCwd, 'src/thing.js', 'hello', 'unrelated later commit');

  await reverifyNeedsReview();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].looksDone, undefined, 'a stranded-branch verdict must never be treated as evidence-gatherable');
  assert.equal(jobs[0].status, 'needs_review');
});

test('reverifyNeedsReview heals a stale shared_tree_reverted row (autoFixAttempted, no outcome) whose landedCommit is still an ancestor of HEAD', async () => {
  const projectCwd = path.join(tmpHome, 'proj-stale-shared-tree');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-stale-shared-tree-slug');
  writePrd(projectCwd, '1229-stale-shared-tree', '# Implementation notes\nEdit `src/thing.js`.');

  const startedAt = new Date(Date.now() - 5000).toISOString();
  await wait(1100);
  commitFile(projectCwd, 'src/thing.js', 'job work', 'the job own commit');
  const landed = git(['rev-parse', 'HEAD'], projectCwd).trim();
  commitFile(projectCwd, 'docs/unrelated.md', 'human', 'human commit after the job');

  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug: '1229-stale-shared-tree',
      status: 'needs_review',
      cwd: projectCwd,
      runId: 'run-1229',
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      verifierVerdict: 'shared_tree_reverted',
      landedCommit: landed,
      autoFixAttempted: true,
    },
  ]);

  await reverifyNeedsReview();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  // Healed rows are archived out of the live queue on the same pass.
  const row = jobs.find((j) => j.slug === '1229-stale-shared-tree');
  assert.ok(!row || row.status === 'completed', 'row must no longer be parked in needs_review');
});
