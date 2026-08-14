/**
 * gitWorktree.test.cjs — PRD 1032: generalized `git worktree` isolation
 * primitives, backing both the job kind (unchanged behavior, mirrored from
 * jobWorktree.test.cjs) and the new epic kind.
 *
 * Exercises the real `git worktree` plumbing against throwaway repos under
 * os.tmpdir() (fast — no network, no Electron).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gitWorktree.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');

let tmpRoot;
let repoCwd;
let originalJobDisable;
let originalJobMax;
let originalEpicDisable;
let originalEpicMax;

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

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gitworktree-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
  originalJobDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  originalJobMax = process.env.SM_JOB_WORKTREE_MAX;
  originalEpicDisable = process.env.SM_EPIC_WORKTREE_DISABLE;
  originalEpicMax = process.env.SM_EPIC_WORKTREE_MAX;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_JOB_WORKTREE_MAX;
  delete process.env.SM_EPIC_WORKTREE_DISABLE;
  delete process.env.SM_EPIC_WORKTREE_MAX;
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
  gitWorktree._resetActiveWorktreeCountForTests('epic', 0);
});

afterEach(async () => {
  const restore = (name, val) => { if (val === undefined) delete process.env[name]; else process.env[name] = val; };
  restore('SM_JOB_WORKTREE_DISABLE', originalJobDisable);
  restore('SM_JOB_WORKTREE_MAX', originalJobMax);
  restore('SM_EPIC_WORKTREE_DISABLE', originalEpicDisable);
  restore('SM_EPIC_WORKTREE_MAX', originalEpicMax);
  // Best-effort: prune any worktree either kind's tests created before removing the repo.
  try { await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job' }); } catch { /* ignore */ }
  try { await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'epic' }); } catch { /* ignore */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ──────────────────────────────────────────── job kind (mirrors jobWorktree.test.cjs)

test('[job] createJobWorktree creates a linked worktree on a fresh branch from HEAD', async () => {
  const slug = 'test-slug-create';
  const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(result.ok).toBe(true);
  expect(fs.existsSync(result.dir)).toBe(true);
  expect(fs.existsSync(path.join(result.dir, 'README.md'))).toBe(true);
  expect(result.branch).toBe(`sm-job/${slug}`);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: result.dir, branch: result.branch });
  expect(fs.existsSync(result.dir)).toBe(false);
});

test('[job] a commit made inside the worktree becomes visible on the main tree HEAD after integrateJobBranch', async () => {
  const slug = 'test-slug-integrate';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'new-file.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);
  const jobCommitSha = git(['rev-parse', 'HEAD'], worktree.dir).trim();

  const headBefore = git(['rev-parse', 'HEAD'], repoCwd).trim();
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);

  const headAfter = git(['rev-parse', 'HEAD'], repoCwd).trim();
  expect(headAfter).not.toBe(headBefore);
  expect(headAfter).toBe(jobCommitSha);
  expect(fs.existsSync(path.join(repoCwd, 'new-file.txt'))).toBe(true);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
  expect(fs.existsSync(worktree.dir)).toBe(false);
});

test('[job] integrateJobBranch is a no-op (integrated:false) when the branch has no new commits', async () => {
  const slug = 'test-slug-noop';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(false);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] a real merge conflict surfaces as an explicit integration failure and preserves the branch', async () => {
  const slug = 'test-slug-conflict';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });

  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'job edit\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job edits README'], worktree.dir);

  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'main tree edit\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main tree edits README'], repoCwd);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toMatch(/conflict|merge failed/i);

  const status = git(['status', '--porcelain'], repoCwd);
  expect(status.trim()).toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  const branches = git(['branch', '--list', worktree.branch], repoCwd);
  expect(branches).toContain(worktree.branch.replace('sm-job/', ''));
});

test('[job] merge-commit message text is byte-for-byte unchanged from the pre-generalization jobWorktree.cjs', async () => {
  const slug = 'test-slug-merge-message';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });

  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'job edit\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job edits README'], worktree.dir);

  fs.writeFileSync(path.join(repoCwd, 'other.txt'), 'main tree edit\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main tree adds other.txt'], repoCwd);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.mergeCommit).toBe(true);

  const lastMessage = git(['log', '-1', '--format=%s'], repoCwd).trim();
  expect(lastMessage).toBe(`merge scheduler job ${slug}`);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] falls back with a reason for a non-git cwd', async () => {
  const nonGitDir = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(nonGitDir, { recursive: true });
  const result = await gitWorktree.createJobWorktree({ cwd: nonGitDir, slug: 'x' });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/not a git repository/);
});

test('[job] falls back with a reason for a dirty base tree (never silently drops uncommitted human WIP)', async () => {
  fs.writeFileSync(path.join(repoCwd, 'dirty.txt'), 'uncommitted\n', 'utf8');
  const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/uncommitted changes/);
});

test('[job] falls back once the concurrency cap is reached, and recovers after cleanup', async () => {
  process.env.SM_JOB_WORKTREE_MAX = '1';
  const first = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cap-1' });
  expect(first.ok).toBe(true);

  const second = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cap-2' });
  expect(second.ok).toBe(false);
  expect(second.reason).toMatch(/cap reached/);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: first.dir, branch: first.branch });

  const third = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cap-3' });
  expect(third.ok).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: third.dir, branch: third.branch });
});

test('[job] SM_JOB_WORKTREE_DISABLE=1 restores in-place behaviour', async () => {
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/SM_JOB_WORKTREE_DISABLE/);
});

test('[job] reconcileWorktreesOnBoot removes a leaked worktree (simulated crash) and its branch', async () => {
  const slug = 'test-slug-leak';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(fs.existsSync(worktree.dir)).toBe(true);
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);

  await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job' });

  expect(fs.existsSync(worktree.dir)).toBe(false);
  const branches = git(['branch', '--list', worktree.branch], repoCwd);
  expect(branches.trim()).toBe('');
});

test('[job] reconcileWorktreesOnBoot defaults to kind:job when no opts are given', async () => {
  const slug = 'test-slug-default-kind';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  await gitWorktree.reconcileWorktreesOnBoot([repoCwd]);
  expect(fs.existsSync(worktree.dir)).toBe(false);
});

test('[job] reconcileWorktreesOnBoot never touches a worktree outside WORKTREE_ROOT', async () => {
  const humanWorktreeDir = path.join(tmpRoot, 'human-made-worktree');
  git(['worktree', 'add', '-b', 'human-branch', humanWorktreeDir, 'HEAD'], repoCwd);
  await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job' });
  expect(fs.existsSync(humanWorktreeDir)).toBe(true);
  git(['worktree', 'remove', '--force', humanWorktreeDir], repoCwd);
});

// ──────────────────────────────────────────── epic kind (new)

test('[epic] createEpicWorktree names the branch sm-epic/<id>, distinct from the job root', async () => {
  const epicId = 'my-epic-abc123';
  const result = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId });
  expect(result.ok).toBe(true);
  expect(result.branch).toBe(`sm-epic/${epicId}`);
  expect(result.dir.startsWith(gitWorktree.worktreeRootFor('epic'))).toBe(true);
  expect(result.dir.startsWith(gitWorktree.worktreeRootFor('job'))).toBe(false);
  expect(fs.existsSync(path.join(result.dir, 'README.md'))).toBe(true);

  await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: result.dir, branch: result.branch });
  expect(fs.existsSync(result.dir)).toBe(false);
});

test('[epic] a commit made inside an epic worktree integrates onto the main tree HEAD', async () => {
  const epicId = 'epic-integrate';
  const worktree = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'epic-file.txt'), 'epic output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'epic commit'], worktree.dir);

  const outcome = await gitWorktree.integrateEpicBranch({ cwd: repoCwd, branch: worktree.branch, epicId });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);
  expect(fs.existsSync(path.join(repoCwd, 'epic-file.txt'))).toBe(true);

  await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[epic] no premature cap eviction — many concurrent epic worktrees stay under the default epic cap', async () => {
  const created = [];
  // The job kind's default cap is 4; prove the epic kind doesn't inherit that
  // ceiling by creating more than 4 concurrent epic worktrees successfully.
  for (let i = 0; i < 6; i++) {
    const result = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: `epic-cap-${i}` });
    expect(result.ok).toBe(true);
    created.push(result);
  }
  expect(gitWorktree._getActiveWorktreeCountForTests('epic')).toBe(6);
  // The job counter must be completely unaffected by epic-kind activity.
  expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(0);

  for (const worktree of created) {
    await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
  }
});

test('[epic] SM_EPIC_WORKTREE_MAX raises/lowers the epic cap independently of the job cap', async () => {
  process.env.SM_EPIC_WORKTREE_MAX = '1';
  const first = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: 'epic-max-1' });
  expect(first.ok).toBe(true);

  const second = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: 'epic-max-2' });
  expect(second.ok).toBe(false);
  expect(second.reason).toMatch(/cap reached/);

  // The job cap (default 4) is untouched by SM_EPIC_WORKTREE_MAX=1.
  const job1 = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'job-max-1' });
  expect(job1.ok).toBe(true);

  await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: first.dir, branch: first.branch });
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: job1.dir, branch: job1.branch });
});

test('[epic] SM_EPIC_WORKTREE_DISABLE=1 restores in-place behaviour independently of the job kill-switch', async () => {
  process.env.SM_EPIC_WORKTREE_DISABLE = '1';
  const epicResult = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: 'x' });
  expect(epicResult.ok).toBe(false);
  expect(epicResult.reason).toMatch(/SM_EPIC_WORKTREE_DISABLE/);

  // The job kind must still work — the two kill-switches are independent.
  const jobResult = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
  expect(jobResult.ok).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: jobResult.dir, branch: jobResult.branch });
});

test('[epic] the per-project UI toggle (epicWorktreeProjectConfig.cjs) disables isolation for just that cwd', async () => {
  const projectConfig = require('../epicWorktreeProjectConfig.cjs');
  const originalOverride = process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH;
  process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH = path.join(tmpRoot, 'epic-worktree-project-config.json');
  try {
    projectConfig.setEpicWorktreeDisabledForProject(repoCwd, true);
    expect(projectConfig.isEpicWorktreeDisabledForProject(repoCwd)).toBe(true);

    const result = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: 'toggle-x' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/isolation toggle/);

    // A different, untouched project cwd is unaffected — the toggle is
    // per-project, not machine-wide like the env var.
    const otherCwd = path.join(tmpRoot, 'other-repo');
    initRepo(otherCwd);
    const otherResult = await gitWorktree.createEpicWorktree({ cwd: otherCwd, epicId: 'toggle-y' });
    expect(otherResult.ok).toBe(true);
    await gitWorktree.cleanupEpicWorktree({ cwd: otherCwd, dir: otherResult.dir, branch: otherResult.branch });

    // Turning it back off restores isolation for the original project.
    projectConfig.setEpicWorktreeDisabledForProject(repoCwd, false);
    expect(projectConfig.isEpicWorktreeDisabledForProject(repoCwd)).toBe(false);
    const restored = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: 'toggle-z' });
    expect(restored.ok).toBe(true);
    await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: restored.dir, branch: restored.branch });
  } finally {
    if (originalOverride === undefined) delete process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH;
    else process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH = originalOverride;
  }
});

test('[epic] reconcileWorktreesOnBoot removes a leaked epic worktree with no liveness predicate given', async () => {
  const epicId = 'epic-leak';
  const worktree = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId });
  expect(fs.existsSync(worktree.dir)).toBe(true);
  gitWorktree._resetActiveWorktreeCountForTests('epic', 0);

  await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'epic' });

  expect(fs.existsSync(worktree.dir)).toBe(false);
  const branches = git(['branch', '--list', worktree.branch], repoCwd);
  expect(branches.trim()).toBe('');
});

test('[epic] reconcileWorktreesOnBoot does NOT remove a worktree whose owning Epic is still active, per the isLive predicate', async () => {
  const liveEpicId = 'epic-still-active';
  const deadEpicId = 'epic-orphaned';
  const liveWorktree = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: liveEpicId });
  const deadWorktree = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: deadEpicId });
  gitWorktree._resetActiveWorktreeCountForTests('epic', 0);

  // Stub for a real active-index.json read (wired in the next PRD in this
  // chain) — this only needs to prove reconcileWorktreesOnBoot accepts and
  // respects a liveness predicate.
  const activeIndexStub = new Set([liveEpicId]);
  const isLive = async (epicId) => activeIndexStub.has(epicId);

  await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'epic', isLive });

  expect(fs.existsSync(liveWorktree.dir)).toBe(true);
  expect(fs.existsSync(deadWorktree.dir)).toBe(false);
  const liveBranches = git(['branch', '--list', liveWorktree.branch], repoCwd);
  expect(liveBranches).toContain(liveEpicId);
  const deadBranches = git(['branch', '--list', deadWorktree.branch], repoCwd);
  expect(deadBranches.trim()).toBe('');

  // Cleanup: the live one is left registered by design; tear it down manually
  // so afterEach's rm doesn't leave a dangling worktree registration.
  await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: liveWorktree.dir, branch: liveWorktree.branch });
});

test('[epic] reconcileWorktreesOnBoot for kind:epic never touches a job-kind worktree, and vice versa', async () => {
  const jobWorktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cross-kind-job' });
  const epicWorktree = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: 'cross-kind-epic' });

  await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'epic' });
  expect(fs.existsSync(jobWorktree.dir)).toBe(true);
  expect(fs.existsSync(epicWorktree.dir)).toBe(false);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: jobWorktree.dir, branch: jobWorktree.branch });
});

test('keyFromBranch strips the kind-specific prefix and returns null for a foreign branch', () => {
  expect(gitWorktree.keyFromBranch('epic', 'sm-epic/abc-123')).toBe('abc-123');
  expect(gitWorktree.keyFromBranch('job', 'sm-job/my-slug')).toBe('my-slug');
  expect(gitWorktree.keyFromBranch('epic', 'sm-job/my-slug')).toBe(null);
  expect(gitWorktree.keyFromBranch('job', 'main')).toBe(null);
});

test('createWorktree throws on an unknown kind', async () => {
  await expect(gitWorktree.createWorktree({ kind: 'bogus', cwd: repoCwd, key: 'x' })).rejects.toThrow(/unknown kind/);
});
