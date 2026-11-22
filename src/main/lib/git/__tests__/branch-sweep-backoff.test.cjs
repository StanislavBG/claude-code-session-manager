/**
 * branch-sweep-backoff.test.cjs — PRD 3494: the stranded-branch sweep keeps a
 * persisted per-(cwd, branch) failure count with backoff, gives up after
 * BRANCH_SWEEP_MAX_FAILURES failures or once the owning PRD is skipped /
 * superseded, and reports each given-up branch exactly once — not at every boot.
 *
 * Each "boot" below is a fresh in-memory attempted set plus a reload of the
 * persisted backoff file, the same shape scheduler.cjs runBranchSweep uses.
 *
 * Run: timeout 300 npx vitest run src/main/lib/git/__tests__/branch-sweep-backoff.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  sweepStrandedJobBranches,
  loadBranchSweepBackoff,
  saveBranchSweepBackoff,
  decideBranchRetry,
  recordBranchFailure,
  takeUnreportedGiveUps,
  listGivenUpBranches,
  BRANCH_SWEEP_MAX_FAILURES,
  BRANCH_SWEEP_BACKOFF_BASE_MS,
} = require('../branchSweep.cjs');

let tmpRoot;
let repoCwd;
let stateFile;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-branchsweep-backoff-'));
  repoCwd = path.join(tmpRoot, 'repo');
  stateFile = path.join(tmpRoot, 'state', 'branch-sweep-backoff.json');
  fs.mkdirSync(repoCwd, { recursive: true });
  git(['init', '-q'], repoCwd);
  git(['config', 'user.email', 'test@example.com'], repoCwd);
  git(['config', 'user.name', 'Test'], repoCwd);
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'initial'], repoCwd);
  delete process.env.SM_BRANCH_SWEEP_DISABLE;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A `sm-job/<slug>` branch that conflicts with HEAD on shared-<slug>.txt. */
function makeConflictingBranch(slug) {
  const file = `shared-${slug}.txt`;
  fs.writeFileSync(path.join(repoCwd, file), 'main version\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', `main edits ${file}`], repoCwd);
  const branch = `sm-job/${slug}`;
  git(['branch', branch, 'HEAD~1'], repoCwd);
  const co = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-branchsweep-backoff-co-'));
  git(['worktree', 'add', '-q', co, branch], repoCwd);
  fs.writeFileSync(path.join(co, file), 'branch version — conflicts\n', 'utf8');
  git(['add', '-A'], co);
  git(['commit', '-q', '-m', `job ${slug} edits ${file}`], co);
  git(['worktree', 'remove', '--force', co], repoCwd);
  return branch;
}

/** One simulated boot: fresh attempted set, state loaded from + saved to disk. */
async function boot(jobs, now) {
  const state = await loadBranchSweepBackoff(stateFile);
  const sweep = await sweepStrandedJobBranches({
    cwd: repoCwd, jobs, attemptedBranches: new Set(), backoff: { state, now },
  });
  const report = takeUnreportedGiveUps(state);
  if (sweep.changed || report.length) await saveBranchSweepBackoff(stateFile, state);
  return { sweep, report, state };
}

const branchExists = (b) => git(['rev-parse', '--verify', b], repoCwd).trim().length === 40;

test('each failed attempt is counted and persisted; the next attempt waits out the backoff', async () => {
  const branch = makeConflictingBranch('count');
  const jobs = [{ slug: 'count', status: 'failed' }];
  const t0 = 1_000_000;

  const b1 = await boot(jobs, t0);
  const r1 = b1.sweep.results.find((r) => r.branch === branch);
  expect(r1.action).toBe('conflict');
  expect(r1.failures).toBe(1);
  expect(r1.gaveUp).toBe(false);
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expect(onDisk.branches[branch].failures).toBe(1);
  expect(onDisk.branches[branch].nextAttemptAt).toBe(t0 + BRANCH_SWEEP_BACKOFF_BASE_MS);

  // A reboot inside the backoff window does not retry (and is no new conflict).
  const b2 = await boot(jobs, t0 + 1000);
  expect(b2.sweep.results.find((r) => r.branch === branch).action).toBe('skip-backoff');
  expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).branches[branch].failures).toBe(1);

  // Past the window it retries, and the count + backoff grow.
  const t1 = t0 + BRANCH_SWEEP_BACKOFF_BASE_MS + 1;
  const b3 = await boot(jobs, t1);
  const r3 = b3.sweep.results.find((r) => r.branch === branch);
  expect(r3.action).toBe('conflict');
  expect(r3.failures).toBe(2);
  expect(b3.state.branches[branch].nextAttemptAt).toBe(t1 + 2 * BRANCH_SWEEP_BACKOFF_BASE_MS);
  expect(b3.report).toEqual([]);
});

test(`gives up at ${BRANCH_SWEEP_MAX_FAILURES} failures, reports once, never retries, never deletes`, async () => {
  const branch = makeConflictingBranch('cap');
  const jobs = [{ slug: 'cap', status: 'failed' }];
  let now = 5_000_000;
  const reports = [];
  for (let i = 1; i <= BRANCH_SWEEP_MAX_FAILURES; i += 1) {
    const b = await boot(jobs, now);
    const r = b.sweep.results.find((x) => x.branch === branch);
    expect(r.action).toBe('conflict');
    expect(r.failures).toBe(i);
    expect(r.gaveUp).toBe(i === BRANCH_SWEEP_MAX_FAILURES);
    reports.push(...b.report);
    now += BRANCH_SWEEP_BACKOFF_BASE_MS * 2 ** i + 1;
  }
  expect(reports).toEqual([{ branch, slug: 'cap', reason: 'max-failures', failures: BRANCH_SWEEP_MAX_FAILURES }]);

  // Many later boots, arbitrarily far in the future: never retried, never re-reported.
  for (let i = 0; i < 3; i += 1) {
    now += 365 * 24 * 3600 * 1000;
    const b = await boot(jobs, now);
    expect(b.sweep.results.find((x) => x.branch === branch).action).toBe('skip-gave-up');
    expect(b.report).toEqual([]);
  }
  expect(branchExists(branch)).toBe(true);
  expect(listGivenUpBranches(await loadBranchSweepBackoff(stateFile)).map((x) => x.branch)).toEqual([branch]);
});

test('a skipped PRD gives up its branch without any merge attempt; superseded too', async () => {
  const skipped = makeConflictingBranch('skipme');
  const superseded = makeConflictingBranch('oldone');
  const headBefore = git(['rev-parse', 'HEAD'], repoCwd).trim();
  const jobs = [
    { slug: 'skipme', status: 'skipped' },
    { slug: 'oldone', status: 'failed', supersededBy: 'newone' },
  ];
  const b = await boot(jobs, 1);
  const rs = b.sweep.results.find((r) => r.branch === skipped);
  const ro = b.sweep.results.find((r) => r.branch === superseded);
  expect(rs).toMatchObject({ action: 'gave-up', reason: 'prd-skipped' });
  expect(rs.integration).toBeUndefined();
  expect(ro).toMatchObject({ action: 'gave-up', reason: 'prd-superseded' });
  expect(git(['rev-parse', 'HEAD'], repoCwd).trim()).toBe(headBefore);
  expect(b.report.map((x) => x.branch).sort()).toEqual([superseded, skipped].sort());
  expect(b.state.branches[skipped].failures).toBe(0);

  const again = await boot(jobs, 2);
  expect(again.sweep.results.find((r) => r.branch === skipped).action).toBe('skip-gave-up');
  expect(again.report).toEqual([]);
  expect(branchExists(skipped)).toBe(true);
  expect(branchExists(superseded)).toBe(true);
});

test('no repeat report: the summary source only yields branches never reported before', async () => {
  const state = { version: 1, branches: {} };
  state.branches['sm-job/a'] = recordBranchFailure(
    recordBranchFailure(recordBranchFailure(undefined, { now: 1 }), { now: 2 }), { now: 3, slug: 'a' },
  );
  expect(state.branches['sm-job/a'].gaveUp).toBe(true);
  expect(takeUnreportedGiveUps(state).map((x) => x.branch)).toEqual(['sm-job/a']);
  expect(takeUnreportedGiveUps(state)).toEqual([]);
  await saveBranchSweepBackoff(stateFile, state);
  expect(takeUnreportedGiveUps(await loadBranchSweepBackoff(stateFile))).toEqual([]);
});

test('decideBranchRetry is the pure give-up decision', () => {
  expect(decideBranchRetry({ entry: undefined, row: null, now: 0 }).action).toBe('attempt');
  expect(decideBranchRetry({ entry: undefined, row: { status: 'skipped' }, now: 0 }))
    .toEqual({ action: 'give-up', reason: 'prd-skipped' });
  expect(decideBranchRetry({ entry: undefined, row: { status: 'cancelled' }, now: 0 }))
    .toEqual({ action: 'give-up', reason: 'prd-superseded' });
  expect(decideBranchRetry({ entry: { failures: 1, nextAttemptAt: 10 }, row: null, now: 5 }).action).toBe('backoff');
  expect(decideBranchRetry({ entry: { failures: 1, nextAttemptAt: 10 }, row: null, now: 10 }).action).toBe('attempt');
  expect(decideBranchRetry({ entry: { failures: 3, nextAttemptAt: null }, row: null, now: 0 }))
    .toEqual({ action: 'give-up', reason: 'max-failures' });
  expect(decideBranchRetry({ entry: { gaveUp: true, gaveUpReason: 'max-failures' }, row: null, now: 0 }).action)
    .toBe('given-up');
});

test('a garbled state file loads as empty instead of throwing', async () => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, '{not json', 'utf8');
  expect(await loadBranchSweepBackoff(stateFile)).toEqual({ version: 1, branches: {} });
});
