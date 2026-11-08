/**
 * scheduler-boot-keeps-adopted-checkout.test.cjs — PRD 2908: the boot job-
 * worktree sweep keeps every checkout partitionBootOrphans adopts.
 *
 * A run that printed SCHEDULER_VERDICT: PASS and exited seconds before the
 * restart has a dead pid and no cwd holder, but a fresh run log — the
 * partition adopts it, and the sweep must leave its checkout + sm-job branch
 * for reapDeadRunningJobs to land. A dead row with a stale log is still swept.
 *
 * Composes partitionBootOrphans + buildJobWorktreeIsLive +
 * jobWorktree.reconcileWorktreesOnBoot exactly as scheduler.cjs init() does,
 * against a real temp git repo.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-boot-keeps-adopted-checkout.test.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { git, initRepo, writeRunLog } = require('./_helpers/schedulerHarness.cjs');

const FRESH_WINDOW_MS = 10 * 60 * 1000;

let tmpHome;
let repo;
let savedEnv;
let scheduler;
let jobWorktree;
let buildJobWorktreeIsLive;
let schedulerPaths;

beforeAll(() => {
  savedEnv = {
    HOME: process.env.HOME,
    SM_WORKTREE_ROOT: process.env.SM_WORKTREE_ROOT,
    SM_JOB_WORKTREE_DISABLE: process.env.SM_JOB_WORKTREE_DISABLE,
    SM_JOB_WORKTREE_MAX: process.env.SM_JOB_WORKTREE_MAX,
  };
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-boot-adopt-home-'));
  process.env.HOME = tmpHome;
  process.env.SM_WORKTREE_ROOT = path.join(tmpHome, 'worktrees');
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_JOB_WORKTREE_MAX;
  scheduler = require('../scheduler.cjs');
  jobWorktree = require('../lib/git/jobWorktree.cjs');
  schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
  ({ buildJobWorktreeIsLive } = require('../lib/git/jobWorktreeBootLive.cjs'));
  repo = path.join(tmpHome, 'repo');
  initRepo(repo);
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function branchExists(cwd, branch) {
  try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd); return true; } catch { return false; }
}

test('an adopted (fresh-log, dead-pid) row keeps its checkout and sm-job branch; a stale-log dead row is swept', async () => {
  jobWorktree._resetActiveWorktreeCountForTests(0);
  const adoptedWt = await jobWorktree.createJobWorktree({ cwd: repo, slug: 'passed-just-before-restart' });
  const staleWt = await jobWorktree.createJobWorktree({ cwd: repo, slug: 'long-dead' });
  expect(adoptedWt.ok).toBe(true);
  expect(staleWt.ok).toBe(true);
  const adoptedDir = jobWorktree.worktreeDirFor(repo, 'passed-just-before-restart');
  const staleDir = jobWorktree.worktreeDirFor(repo, 'long-dead');
  const adoptedBranch = jobWorktree.branchNameFor('passed-just-before-restart');
  const staleBranch = jobWorktree.branchNameFor('long-dead');

  // The PASS run committed on its branch before exiting.
  fs.writeFileSync(path.join(adoptedDir, 'work.txt'), 'done\n');
  git(['add', 'work.txt'], adoptedDir);
  git(['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '-m', 'feat: work'], adoptedDir);

  writeRunLog('run-adopted', 'passed-just-before-restart', ['{"type":"result","subtype":"success","result":"SCHEDULER_VERDICT: PASS"}']);
  writeRunLog('run-stale', 'long-dead', ['{"type":"system"}']);
  const runsDir = schedulerPaths.runsDir();
  const logOf = (j) => path.join(runsDir, j.runId, `${j.slug}.log`);
  const now = Date.now();
  const old = new Date(now - 24 * 60 * 60 * 1000);
  fs.utimesSync(logOf({ runId: 'run-stale', slug: 'long-dead' }), old, old);

  const bootJobs = [
    { slug: 'passed-just-before-restart', status: 'running', cwd: repo, runId: 'run-adopted', runtime: { pid: 999991 } },
    { slug: 'long-dead', status: 'running', cwd: repo, runId: 'run-stale', runtime: { pid: 999992 } },
  ];

  // Same order as init(): partition first, then the sweep keeps what it adopted.
  const { immediate, adopted } = scheduler.partitionBootOrphans(bootJobs, {
    pidAlive: () => false,
    getLogMtimeMs: (j) => { try { return fs.statSync(logOf(j)).mtimeMs; } catch { return null; } },
    logFreshWindowMs: FRESH_WINDOW_MS,
    runsDir,
    now,
  });
  expect(adopted).toEqual(['passed-just-before-restart']);
  expect(immediate).toEqual(['long-dead']);

  const isLive = buildJobWorktreeIsLive({
    bootJobs,
    claudePidAlive: () => false,
    hasLiveHolder: () => false,
    cwdHolders: new Set(),
    adoptedSlugs: new Set(adopted),
  });
  await jobWorktree.reconcileWorktreesOnBoot([repo], { isLive });

  expect(fs.existsSync(adoptedDir)).toBe(true);
  expect(branchExists(repo, adoptedBranch)).toBe(true);
  expect(fs.existsSync(path.join(adoptedDir, 'work.txt'))).toBe(true);

  expect(fs.existsSync(staleDir)).toBe(false);
  expect(branchExists(repo, staleBranch)).toBe(false);
});
