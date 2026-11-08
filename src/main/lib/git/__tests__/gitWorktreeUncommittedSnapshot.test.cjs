/**
 * PRD 2891 — every worktree removal snapshots uncommitted work first
 * (snapshotUncommittedWork), and worktreeRunCommitCount counts a run's own
 * commits from the checkout's HEAD reflog. Real temp repo + real worktrees.
 */
import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');
const gitExec = require('../gitExec.cjs');
const jobWorktree = require('../jobWorktree.cjs');

let tmpRoot;
let repoCwd;
let originalWorktreeRoot;
let templateRoot;
let templateRepo;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function uncommittedRefs(cwd) {
  return git(['for-each-ref', '--format=%(refname)', gitExec.UNCOMMITTED_REF_PREFIX], cwd).trim();
}

beforeAll(() => {
  templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-uncommitted-tpl-'));
  templateRepo = path.join(templateRoot, 'repo');
  initRepo(templateRepo);
});
afterAll(() => {
  if (templateRoot) fs.rmSync(templateRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-uncommitted-'));
  repoCwd = path.join(tmpRoot, 'repo');
  fs.cpSync(templateRepo, repoCwd, { recursive: true });
  originalWorktreeRoot = process.env.SM_WORKTREE_ROOT;
  process.env.SM_WORKTREE_ROOT = path.join(tmpRoot, 'worktrees');
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_JOB_WORKTREE_MAX;
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
  gitWorktree._resetObservedWorktreeCountCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { git(['worktree', 'prune'], repoCwd); } catch { /* ignore */ }
  if (originalWorktreeRoot === undefined) delete process.env.SM_WORKTREE_ROOT;
  else process.env.SM_WORKTREE_ROOT = originalWorktreeRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('exports UNCOMMITTED_REF_PREFIX and the new functions from jobWorktree', () => {
  expect(gitExec.UNCOMMITTED_REF_PREFIX).toBe('refs/sm-uncommitted/');
  expect(typeof jobWorktree.snapshotUncommittedWork).toBe('function');
  expect(typeof jobWorktree.worktreeRunCommitCount).toBe('function');
});

test('dirty tracked + untracked files are snapshotted as a pinned commit readable via git show', async () => {
  const wt = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'snap-dirty' });
  expect(wt.ok).toBe(true);
  fs.writeFileSync(path.join(wt.dir, 'README.md'), 'changed\n');
  fs.mkdirSync(path.join(wt.dir, 'sub'));
  fs.writeFileSync(path.join(wt.dir, 'sub', 'new.txt'), 'brand new\n');
  fs.writeFileSync(path.join(wt.dir, 'ignored.log'), 'noise\n');
  const head = git(['rev-parse', 'HEAD'], wt.dir).trim();
  const indexBefore = fs.readFileSync(git(['rev-parse', '--git-path', 'index'], wt.dir).trim().replace(/^(?!\/)/, `${wt.dir}/`));

  const snap = await gitWorktree.snapshotUncommittedWork({ cwd: repoCwd, dir: wt.dir, key: 'snap-dirty' });
  expect(snap && snap.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(snap.ref).toBe(`refs/sm-uncommitted/snap-dirty/${snap.sha}`);
  expect(snap.paths.sort()).toEqual(['README.md', 'sub/new.txt']);
  expect(git(['show', `${snap.sha}:README.md`], repoCwd)).toBe('changed\n');
  expect(git(['show', `${snap.sha}:sub/new.txt`], repoCwd)).toBe('brand new\n');
  expect(() => git(['show', `${snap.sha}:ignored.log`], repoCwd)).toThrow();
  expect(git(['rev-parse', `${snap.sha}^`], repoCwd).trim()).toBe(head);
  expect(uncommittedRefs(repoCwd)).toBe(snap.ref);
  // The checkout's own index and the shared stash stack are untouched.
  const indexAfter = fs.readFileSync(git(['rev-parse', '--git-path', 'index'], wt.dir).trim().replace(/^(?!\/)/, `${wt.dir}/`));
  expect(indexAfter.equals(indexBefore)).toBe(true);
  expect(git(['stash', 'list'], repoCwd).trim()).toBe('');
  expect(git(['status', '--porcelain'], wt.dir)).toContain('?? sub/');

  // cleanupWorktree threads the snapshot back and removes the dir.
  const res = await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: wt.dir, branch: wt.branch });
  expect(res.snapshot.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(fs.existsSync(wt.dir)).toBe(false);
});

test('a clean checkout returns null and writes no ref', async () => {
  const wt = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'snap-clean' });
  const snap = await gitWorktree.snapshotUncommittedWork({ cwd: repoCwd, dir: wt.dir, key: 'snap-clean' });
  expect(snap).toBeNull();
  expect(uncommittedRefs(repoCwd)).toBe('');
  const res = await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: wt.dir, branch: wt.branch });
  expect(res.snapshot).toBeNull();
  expect(fs.existsSync(wt.dir)).toBe(false);
});

test('a checkout whose only dirty paths are identical to the main checkout returns null', async () => {
  const wt = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'snap-carried' });
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'carried wip\n');
  fs.writeFileSync(path.join(wt.dir, 'README.md'), 'carried wip\n');
  fs.writeFileSync(path.join(repoCwd, 'extra.txt'), 'same\n');
  fs.writeFileSync(path.join(wt.dir, 'extra.txt'), 'same\n');
  const snap = await gitWorktree.snapshotUncommittedWork({ cwd: repoCwd, dir: wt.dir, key: 'snap-carried' });
  expect(snap).toBeNull();
  expect(uncommittedRefs(repoCwd)).toBe('');
});

test('a forced snapshot error keeps the directory on disk', async () => {
  const wt = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'snap-error' });
  fs.writeFileSync(path.join(wt.dir, 'work.txt'), 'precious\n');
  const real = gitExec.execGit;
  vi.spyOn(gitExec, 'execGit').mockImplementation((cwd, args, opts) => {
    if (args[0] === 'write-tree') return Promise.reject(new Error('forced write-tree failure'));
    return real(cwd, args, opts);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const snap = await gitWorktree.snapshotUncommittedWork({ cwd: repoCwd, dir: wt.dir, key: 'snap-error' });
  expect(snap.error).toMatch(/forced/);
  expect(snap.paths).toEqual(['work.txt']);

  const res = await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: wt.dir, branch: wt.branch });
  expect(res.snapshot.error).toBeTruthy();
  expect(fs.existsSync(path.join(wt.dir, 'work.txt'))).toBe(true);
  // A kept checkout must not leak a dispatch-cap count.
  expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(0);
  vi.restoreAllMocks();
  // Cleanup now succeeds and pins the work.
  const again = await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: wt.dir, branch: wt.branch });
  expect(again.snapshot.sha).toBeTruthy();
  expect(fs.existsSync(wt.dir)).toBe(false);
});

test('reconcileWorktreesOnBoot snapshots a dirty non-live job worktree before removing it', async () => {
  const wt = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'boot-dirty' });
  fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'uncommitted\n');
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const result = await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job', isLive: async () => false });
  expect(result.checkoutsRemoved).toBe(1);
  expect(result.kept).toEqual([]);
  expect(result.snapshots).toHaveLength(1);
  const s = result.snapshots[0];
  expect(s).toMatchObject({ cwd: repoCwd, key: 'boot-dirty', paths: ['a.txt'] });
  expect(s.ref).toBe(`refs/sm-uncommitted/boot-dirty/${s.sha}`);
  expect(git(['show', `${s.sha}:a.txt`], repoCwd)).toBe('uncommitted\n');
  expect(fs.existsSync(wt.dir)).toBe(false);
});

test('reconcileWorktreesOnBoot keeps a checkout whose snapshot fails, and keeps its branch', async () => {
  const wt = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'boot-keep' });
  fs.writeFileSync(path.join(wt.dir, 'a.txt'), 'uncommitted\n');
  const real = gitExec.execGit;
  vi.spyOn(gitExec, 'execGit').mockImplementation((cwd, args, opts) => {
    if (args[0] === 'commit-tree') return Promise.reject(new Error('forced commit-tree failure'));
    return real(cwd, args, opts);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const result = await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job' });
  expect(result.checkoutsRemoved).toBe(0);
  expect(result.snapshots).toEqual([]);
  expect(result.kept).toHaveLength(1);
  expect(result.kept[0]).toMatchObject({ cwd: repoCwd, key: 'boot-keep' });
  expect(fs.existsSync(path.join(wt.dir, 'a.txt'))).toBe(true);
  expect(git(['branch', '--list', wt.branch], repoCwd).trim()).not.toBe('');
});

test('worktreeRunCommitCount is 0 for a fresh checkout and 1 after a commit', async () => {
  const wt = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'count' });
  expect(await gitWorktree.worktreeRunCommitCount({ dir: wt.dir })).toBe(0);
  fs.writeFileSync(path.join(wt.dir, 'c.txt'), 'c\n');
  git(['add', 'c.txt'], wt.dir);
  git(['commit', '-q', '-m', 'run commit'], wt.dir);
  expect(await gitWorktree.worktreeRunCommitCount({ dir: wt.dir })).toBe(1);
  expect(await gitWorktree.worktreeRunCommitCount({ dir: path.join(tmpRoot, 'nope') })).toBe(-1);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: wt.dir, branch: wt.branch, keepBranch: true });
});
