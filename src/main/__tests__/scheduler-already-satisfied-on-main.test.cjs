/**
 * scheduler-already-satisfied-on-main.test.cjs — PRD 1136.
 *
 * Two live rows (1133-reaper-must-verify-integration-before-completed,
 * 1134-land-stranded-sm-job-branches) were false-negatived on 2026-09-06:
 * their work had already landed on main before their runs dispatched, so
 * each run exited 0, made no commit, and left a clean tree — the exact
 * 'silent_no_op' shape commitGuardVerdict parks as needs_review ("finish
 * protocol incomplete"). Both then auto-minted a redundant `-fix-` child
 * queued to re-do already-shipped work.
 *
 * This exercises the full finalize decision chain — commitGuardVerdict
 * (unchanged) feeding resolveCommitGuardOutcome (new) — entirely at the
 * pure-function level, per standards.md's TDD guidance and the PRD's own
 * implementation note to prefer a pure isAlreadySatisfiedOnMain-style helper
 * over driving the whole spawnJob pipeline.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-already-satisfied-on-main.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { commitGuardVerdict } = require('../scheduler.cjs');
const { selectAutoFixTargets } = require('../scheduler/reviewLadder.cjs');
const { resolveCommitGuardOutcome, isAlreadySatisfiedOnMain } = require('../lib/scheduler/reaperHelpers.cjs');

const noSiblingOnDisk = () => false;

// AC 1: exit 0 / no commit / clean tree, with a commit on main newer than
// queuedAt touching the PRD's declared paths → completed, naming the sha.
test('silent_no_op + a satisfying commit on main → completed-shaped verdict naming the sha, not needs_review', () => {
  const guardVerdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: false,
    verifyResult: null,
  });
  expect(guardVerdict.verdict).toBe('silent_no_op'); // sanity: this is the shape 1133/1134 hit

  const outcome = resolveCommitGuardOutcome(guardVerdict, ['5de4134abc123']);
  expect(outcome.verdict).toBe('already_satisfied_on_main');
  expect(outcome.verdict).not.toBe('needs_review');
  expect(outcome.satisfyingSha).toBe('5de4134abc123');
  expect(outcome.reason).toMatch(/5de4134abc123/);
});

// PRD 2411: verifyRun no longer exempts an edit-only no-commit PASS by tracked
// paths; the 655 shape reaches already_satisfied_on_main through the commit guard.
test('655 shape: no-commit PASS whose declared paths landed after queuedAt → already_satisfied_on_main (completed)', () => {
  const guardVerdict = commitGuardVerdict({
    newlyDirty: [], siblingRunning: false, jobSelfCommitted: false,
    legitimateNoOp: false, isFixPlanJob: false, verifyResult: null,
  });
  const outcome = resolveCommitGuardOutcome(guardVerdict, ['e13168d']);
  expect(outcome.verdict).toBe('already_satisfied_on_main');
});

// AC 2: the inverse — same clean-tree/no-commit shape, but NO commit on main
// satisfies it → still parks as the existing 'finish protocol incomplete'
// verdict. The gate must not be weakened into always-passing.
test('silent_no_op + NO satisfying commit on main → unchanged silent_no_op verdict, still parks needs_review', () => {
  const guardVerdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: false,
    verifyResult: null,
  });

  const outcome = resolveCommitGuardOutcome(guardVerdict, []);
  expect(outcome).toBe(guardVerdict); // untouched — same object, not just same shape
  expect(outcome.verdict).toBe('silent_no_op');
  expect(outcome.downgradeTo).toBe('needs_review');
  expect(outcome.reason).toMatch(/finish protocol incomplete/);
});

test('resolveCommitGuardOutcome never touches the uncommitted_changes shape, satisfied or not', () => {
  const guardVerdict = commitGuardVerdict({
    newlyDirty: ['src/main/someFeature.cjs'],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    verifyResult: null,
  });
  expect(guardVerdict.verdict).toBe('uncommitted_changes');

  const outcome = resolveCommitGuardOutcome(guardVerdict, ['5de4134abc123']);
  expect(outcome).toBe(guardVerdict);
  expect(outcome.verdict).toBe('uncommitted_changes');
});

test('resolveCommitGuardOutcome: null guardVerdict (no violation) passes through as null', () => {
  expect(resolveCommitGuardOutcome(null, ['5de4134'])).toBeNull();
});

// AC 3: a job terminalised via the already-satisfied path never becomes a
// fix-plan target — selectAutoFixTargets only ever considers needs_review
// rows, and the already-satisfied path never produces one.
test('a job whose status is completed (the already-satisfied outcome) is never selected for an auto-fix child', () => {
  const jobs = [{
    slug: '1133-reaper-must-verify-integration-before-completed',
    status: 'completed',
    runId: '2026-09-06T13-03-00-000Z',
    verifierVerdict: 'already_satisfied_on_main',
  }];
  const targets = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  expect(targets).toEqual([]);
});

test('isAlreadySatisfiedOnMain picks the newest (first) satisfying commit when several land', () => {
  const verdict = isAlreadySatisfiedOnMain(['newest111', 'older222']);
  expect(verdict.sha).toBe('newest111');
});

// findSatisfyingCommitOnMain against a real master-default repo, PRD Files list.
describe('findSatisfyingCommitOnMain: master-default repo + Files list', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { findSatisfyingCommitOnMain } = require('../scheduler.cjs');

  function setup(commitB) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-master-'));
    const git = (...a) => execFileSync('git', ['-C', dir, ...a]);
    git('init', '-q', '-b', 'master');
    git('config', 'user.email', 't@t.com');
    git('config', 'user.name', 'T');
    const queued = Math.floor(Date.now() / 1000);
    const commit = (rel, msg) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), msg);
      git('add', rel);
      const d = `@${queued + 5} +0000`;
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', msg], { env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
    };
    commit('src/a.cjs', 'a');
    if (commitB) commit('src/b.cjs', 'b');
    const slug = `sat-master-${path.basename(dir)}`;
    const archDir = path.join(dir, 'session-manager-operations', 'scheduler', 'prds-archived');
    fs.mkdirSync(archDir, { recursive: true });
    fs.writeFileSync(path.join(archDir, `${slug}.md`), '---\nslug: x\n---\n# Files\n\n- src/a.cjs\n- src/b.cjs\n');
    return { cwd: dir, slug, queuedAt: new Date((queued - 2) * 1000).toISOString() };
  }

  test('every Files entry committed after queuedAt → SHAs', async () => {
    const shas = await findSatisfyingCommitOnMain(setup(true));
    expect(shas.length).toBe(2);
  });

  test('one Files entry without a commit → []', async () => {
    expect(await findSatisfyingCommitOnMain(setup(false))).toEqual([]);
  });
});
