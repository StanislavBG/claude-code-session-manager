/**
 * scheduler-stranded-autofix-park.test.cjs — PRD "1218-fo-01 stranded
 * auto-fix park" (2026-09-13, findings filed at session-manager-operations/
 * reviews/2026-09-13-scheduler-stability-investigation.md, "post-run
 * adjudication" section).
 *
 * spawnInvestigation restores a job's status from 'investigating' back to
 * needs_review in ONE mutate() call (scheduler.cjs, source
 * 'spawnInvestigation:onExit') and stamps autoFixOutcome in a SEPARATE,
 * later mutate() call. A crash/restart between the two leaves a row with
 * autoFixAttempted: true and autoFixOutcome permanently undefined —
 * isExhaustedAutoFix wants autoFixRetries >= 1 (never incremented here) and
 * isGuardParkedWithoutAutoFix wants autoFixAttempted === false, so the row
 * falls through every resolving door and the periodic reverify pass just
 * re-scans the same frozen transcript forever. Job 1218-fo-01 sat exactly
 * like this with a landed commit while every dependent PRD waited.
 *
 * This file covers the new isStrandedAutoFixPark predicate and its wiring
 * into isEligibleForNeedsReviewAutoResolve / selectExhaustedNeedsReviewTargets
 * / applyNeedsReviewAutoResolve — the SAME bounded ladder the exhausted-
 * auto-fix and guard-parked doors already use, unchanged.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — same
 * reason as scheduler-looks-done.test.cjs (appendAuditEvent writes under
 * $HOME/.claude/session-manager/audit-log.jsonl).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-stranded-autofix-park.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stranded-autofix-park-test-'));
process.env.HOME = tmpHome;

// Fixture cwd must be a REAL, writable dir: transitionJob out of needs_review
// fire-and-forgets a history append under <cwd>/session-manager-operations. A fake
// path made it fail EACCES AFTER the sync test returned, so its console.error hit
// vitest mid worker-close ("Closing rpc while onUserConsoleLog was pending").
const PROJECT_CWD = path.join(tmpHome, 'project');
fs.mkdirSync(PROJECT_CWD, { recursive: true });

const {
  isStrandedAutoFixPark,
  isExhaustedAutoFix,
  isGuardParkedWithoutAutoFix,
  isEligibleForNeedsReviewAutoResolve,
  selectExhaustedNeedsReviewTargets,
  applyNeedsReviewAutoResolve,
  computeLooksDone,
  fixSlugFor,
  NEEDS_REVIEW_RESOLVE_CAP,
} = require('../scheduler.cjs');
const { resolvePrdWriteDir } = require('../lib/prdLocations.cjs');
const { bustCwdCache } = require('../lib/queueStore.cjs');

const MIN_MS = 60_000;
const THRESHOLD_MS = 30 * MIN_MS;

// findPrdDir (via resolvePrdsDirs -> allProjectCwds) only discovers a PRD
// dir under a cwd it already knows about — same registration computeLooksDone
// needs in scheduler-looks-done.test.cjs / scheduler-guard-verdict-autoresolve.test.cjs.
function registerActiveProject(cwd, slug) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', slug);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();
}

// Replays the live 1218-fo-01 tuple: needs_review, verifierVerdict
// transcript_errors, exitCode 0, a landed commit, autoFixAttempted true,
// autoFixOutcome undefined, statusHistory ending in the exact
// spawnInvestigation:onExit restore reason.
function strandedJob(overrides = {}) {
  return {
    slug: '1218-fo-01-move-scripts-lib-into-src-main-lib',
    cwd: PROJECT_CWD,
    status: 'needs_review',
    exitCode: 0,
    verifierVerdict: 'transcript_errors',
    landedCommit: 'd1edf15babc1234',
    autoFixAttempted: true,
    statusHistory: [
      { to: 'needs_review', at: new Date(Date.now() - 45 * MIN_MS).toISOString() },
      { to: 'investigating', at: new Date(Date.now() - 40 * MIN_MS).toISOString(), reason: 'spawning investigation probe' },
      {
        to: 'needs_review',
        at: new Date(Date.now() - 35 * MIN_MS).toISOString(),
        reason: 'investigation probe exited — restoring prior status',
      },
    ],
    ...overrides,
  };
}

// --- isStrandedAutoFixPark ---

test('the 1218 tuple (autoFixAttempted true, autoFixOutcome undefined, no child row) is a stranded auto-fix park', () => {
  const job = strandedJob();
  assert.equal(isStrandedAutoFixPark(job, [job]), true);
  assert.equal(isExhaustedAutoFix(job), false, 'never accumulated a retry — must not double-count as exhausted');
  assert.equal(isGuardParkedWithoutAutoFix(job), false, 'autoFixAttempted is true — the guard-parked door requires false');
});

test('autoFixOutcome "error" or "no-plan" with an unspent retry is NOT stranded — selectAutoFixTargets still owns it', () => {
  // Durably stamped (unlike the 1218 tuple's permanently-unset outcome), so
  // its one bounded retry (autoFixRetries < 1) is still selectAutoFixTargets's
  // to spend — pulling it into this ladder instead would race it away from
  // that retry (see scheduler-needs-review-autoresolve.test.cjs's "a
  // non-exhausted needs_review row … is left alone").
  assert.equal(isStrandedAutoFixPark(strandedJob({ autoFixOutcome: 'error' }), []), false);
  assert.equal(isStrandedAutoFixPark(strandedJob({ autoFixOutcome: 'no-plan' }), []), false);
});

test('autoFixOutcome "plan" is never a stranded park — that is isPlanUnqueued/isFixPlanDead territory', () => {
  assert.equal(isStrandedAutoFixPark(strandedJob({ autoFixOutcome: 'plan' }), []), false);
});

test('a row that never attempted auto-fix at all is not a stranded park', () => {
  assert.equal(isStrandedAutoFixPark(strandedJob({ autoFixAttempted: undefined }), []), false);
});

test('a row not in needs_review is never a stranded park, whatever its autoFix* fields say', () => {
  assert.equal(isStrandedAutoFixPark(strandedJob({ status: 'failed' }), []), false);
});

test('a live fix-plan child (running) means there IS something in flight — not stranded', () => {
  const job = strandedJob();
  const child = { slug: fixSlugFor(job), status: 'running' };
  assert.equal(isStrandedAutoFixPark(job, [job, child]), false);
});

test('a row with a live investigating status (the fix-plan child mid-probe) is NOT selected', () => {
  const job = strandedJob();
  const child = { slug: fixSlugFor(job), status: 'investigating' };
  assert.equal(isStrandedAutoFixPark(job, [job, child]), false);
  assert.equal(selectExhaustedNeedsReviewTargets([job, child], Date.now(), THRESHOLD_MS).length, 0);
});

test('a queued (pending) fix-plan child also blocks the stranded-park door', () => {
  const job = strandedJob();
  const child = { slug: fixSlugFor(job), status: 'pending' };
  assert.equal(isStrandedAutoFixPark(job, [job, child]), false);
});

test('a DEAD fix-plan child (needs_review/failed/quarantined/skipped) does not block it — nothing left to wait on', () => {
  const job = strandedJob();
  for (const deadStatus of ['needs_review', 'failed', 'quarantined', 'skipped']) {
    const child = { slug: fixSlugFor(job), status: deadStatus };
    assert.equal(isStrandedAutoFixPark(job, [job, child]), true, `child status ${deadStatus} must not block`);
  }
});

test('a COMPLETED fix-plan child does not block it either', () => {
  const job = strandedJob();
  const child = { slug: fixSlugFor(job), status: 'completed' };
  assert.equal(isStrandedAutoFixPark(job, [job, child]), true);
});

test('isEligibleForNeedsReviewAutoResolve admits the stranded-park door alongside the other two', () => {
  const job = strandedJob();
  assert.equal(isEligibleForNeedsReviewAutoResolve(job, [job]), true);
});

// --- selectExhaustedNeedsReviewTargets: age-gated selection ---

test('a fresh stranded park (under threshold) is not selected', () => {
  const job = strandedJob({
    statusHistory: [
      { to: 'needs_review', at: new Date(Date.now() - 2 * MIN_MS).toISOString(), reason: 'investigation probe exited — restoring prior status' },
    ],
  });
  assert.equal(selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('a stranded park past NEEDS_REVIEW_RESOLVE_MS, under the cap, IS selected', () => {
  const job = strandedJob();
  const found = selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS);
  assert.equal(found.length, 1);
  assert.equal(found[0].slug, job.slug);
});

// --- applyNeedsReviewAutoResolve: same bounded ladder, entered via the new door ---

test('computeLooksDone evidence completes the stranded row via the existing looksDone branch', async () => {
  const projectCwd = fs.mkdtempSync(path.join(tmpHome, 'proj-stranded-'));
  fs.mkdirSync(projectCwd, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: projectCwd, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(projectCwd, 'README.md'), 'hello\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  registerActiveProject(projectCwd, path.basename(projectCwd));

  const dir = resolvePrdWriteDir(projectCwd);
  fs.mkdirSync(dir, { recursive: true });
  const slug = '1218-fo-01-move-scripts-lib-into-src-main-lib';
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\ntitle: Test PRD\ncwd: ${projectCwd}\nestimateMinutes: 30\n---\n# Implementation notes\nEdit \`src/thing.js\`.\n`,
  );

  const startedAt = new Date(Date.now() - 60 * MIN_MS).toISOString();
  await new Promise((r) => setTimeout(r, 1100)); // git --since has 1s resolution
  fs.mkdirSync(path.join(projectCwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectCwd, 'src', 'thing.js'), 'module.exports = {};\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', `the actual fix for ${slug} landed`]);

  const job = strandedJob({ slug, cwd: projectCwd, startedAt });
  assert.equal(isStrandedAutoFixPark(job, [job]), true);

  const looksDone = await computeLooksDone(job);
  assert.ok(looksDone, 'expected computeLooksDone to find the attributable commit');
  job.looksDone = looksDone;

  const outcome = applyNeedsReviewAutoResolve(job, [job]);
  assert.equal(outcome, 'completed');
  assert.equal(job.status, 'completed');
});

test('with no completion evidence yet, the stranded row gets one bounded requeue, same cap/logic as the other doors', () => {
  const job = strandedJob({ exhaustedResolveAttempts: 0 });
  assert.equal(job.looksDone, undefined);
  const outcome = applyNeedsReviewAutoResolve(job, [job]);
  assert.equal(outcome, 'requeued');
  assert.equal(job.status, 'pending');
  assert.equal(job.exhaustedResolveAttempts, 1);
});

test('once the cap is spent, the stranded row auto-skips like every other door', () => {
  const job = strandedJob({ exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP });
  const outcome = applyNeedsReviewAutoResolve(job, [job]);
  assert.equal(outcome, 'skipped');
  assert.equal(job.status, 'skipped');
  assert.equal(job.needsReviewAutoResolvedSkip, true);
});

test('a live fix-plan child also blocks applyNeedsReviewAutoResolve, not just selection', () => {
  const job = strandedJob();
  const child = { slug: fixSlugFor(job), status: 'running' };
  const outcome = applyNeedsReviewAutoResolve(job, [job, child]);
  assert.equal(outcome, null, 'nothing to resolve while the fix-plan child is still live');
  assert.equal(job.status, 'needs_review', 'must stay parked while the child is in flight');
});
