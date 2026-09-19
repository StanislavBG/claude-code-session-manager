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

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');

let tmpRoot;
let repoCwd;
let originalJobDisable;
let originalJobMax;
let originalEpicDisable;
let originalEpicMax;
let originalWorktreeRoot;

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
  // Every sweep below runs against THIS throwaway root, never the live job-worktree root.
  originalWorktreeRoot = process.env.SM_WORKTREE_ROOT;
  process.env.SM_WORKTREE_ROOT = path.join(tmpRoot, 'worktrees');
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
  gitWorktree._resetObservedWorktreeCountCacheForTests();
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
  restore('SM_WORKTREE_ROOT', originalWorktreeRoot);
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

test('[job] integration is skipped (carried-wip-only) when the branch only commits the carried base WIP, and the base tree stays untouched', async () => {
  const slug = 'test-slug-carried-wip-only';
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);
  expect(worktree.carriedPaths).toEqual(['README.md']);

  // The job commits exactly the carried content, doing no other work.
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'commit carried README'], worktree.dir);

  const headBefore = git(['rev-parse', 'HEAD'], repoCwd).trim();
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug, carriedPaths: worktree.carriedPaths });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(false);
  expect(outcome.reason).toBe('carried-wip-only');

  const headAfter = git(['rev-parse', 'HEAD'], repoCwd).trim();
  expect(headAfter).toBe(headBefore);
  // The base tree's own uncommitted README edit is untouched — never
  // discarded, never re-applied.
  expect(git(['status', '--porcelain'], repoCwd)).toContain('README.md');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: !outcome.ok });
});

test('[job] a branch that commits carried paths ALONGSIDE its own work auto-resolves the merge (PRD 1125: carried path is byte-identical duplicate, real work still lands)', async () => {
  const slug = 'test-slug-carried-plus-own-work';
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);
  expect(worktree.carriedPaths).toEqual(['README.md']);

  fs.writeFileSync(path.join(worktree.dir, 'new-file.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit touching carried path + own work'], worktree.dir);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug, carriedPaths: worktree.carriedPaths });
  // The base tree still holds README.md dirty, but its content is BYTE
  // IDENTICAL to the branch's committed copy (the branch never edited it,
  // only carried it through) — this is exactly the shape PRD 1125 teaches
  // integrateBranch to auto-resolve: discard the duplicate, retry once, land
  // the job's real new-file.txt commit too. Not the carried-wip-only
  // shortcut (that only fires when the branch's ONLY changes are carried
  // paths) — here the merge itself is what resolves.
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);
  expect(outcome.autoResolved).toBe('identical_working_tree_duplicates');
  expect(outcome.resolvedPaths).toEqual(['README.md']);
  expect(fs.existsSync(path.join(repoCwd, 'new-file.txt'))).toBe(true);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: !outcome.ok });
});

test('[job] a branch that ADDS its own edit on top of the carried content on the SAME path is never classified carried-wip-only (content-verify, not path-only)', async () => {
  const slug = 'test-slug-carried-same-path-plus-edit';
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);
  expect(worktree.carriedPaths).toEqual(['README.md']);

  // The job's real work lands on the SAME path the base tree had WIP on —
  // committing MORE than just the carried content. A path-only check would
  // wrongly see "only README.md changed, and README.md was carried" and
  // classify this as carried-wip-only, causing the caller to delete this
  // branch (and the job's real commit with it) instead of attempting a
  // normal merge.
  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'uncommitted tracked edit\njob added this line\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job extends the carried README further'], worktree.dir);

  const headBefore = git(['rev-parse', 'HEAD'], repoCwd).trim();
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug, carriedPaths: worktree.carriedPaths });
  // The base tree still holds README.md dirty, so a real merge attempt here
  // is expected to fail exactly like the existing worktreeIntegrationFailure
  // path — branch preserved, not merged, not silently discarded.
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBeTruthy();
  expect(outcome.reason).not.toBe('carried-wip-only');

  const headAfter = git(['rev-parse', 'HEAD'], repoCwd).trim();
  expect(headAfter).toBe(headBefore);
  const branches = git(['branch', '--list', worktree.branch], repoCwd);
  expect(branches).toContain(worktree.branch.replace('sm-job/', ''));

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

test('[job] falls back with a reason for a non-git cwd', async () => {
  const nonGitDir = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(nonGitDir, { recursive: true });
  const result = await gitWorktree.createJobWorktree({ cwd: nonGitDir, slug: 'x' });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/not a git repository/);
});

test('[job] a dirty tracked base file is carried into the worktree with identical content, and the base tree is never written to', async () => {
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const statusBefore = git(['status', '--porcelain'], repoCwd);
  const stashBefore = git(['stash', 'list'], repoCwd);

  const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
  expect(result.ok).toBe(true);
  expect(result.carriedPaths).toEqual(['README.md']);
  expect(fs.readFileSync(path.join(result.dir, 'README.md'), 'utf8')).toBe('uncommitted tracked edit\n');

  const statusAfter = git(['status', '--porcelain'], repoCwd);
  const stashAfter = git(['stash', 'list'], repoCwd);
  expect(statusAfter).toBe(statusBefore);
  expect(stashAfter).toBe(stashBefore);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: result.dir, branch: result.branch });
});

test('[job] an untracked-only dirty base file is NOT carried and stays on the existing clean-create path', async () => {
  fs.writeFileSync(path.join(repoCwd, 'scratch.txt'), 'stray scratch file\n', 'utf8');
  const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
  expect(result.ok).toBe(true);
  expect(result.carriedPaths).toEqual([]);
  expect(fs.existsSync(path.join(result.dir, 'scratch.txt'))).toBe(false);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: result.dir, branch: result.branch });
});

test('[job] carry-over failure (git apply cannot apply) degrades cleanly: worktree torn down, ok:false, active count released', async () => {
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const spy = vi.spyOn(gitWorktree, 'captureAndCarryBaseDiff').mockResolvedValue({ ok: false, reason: 'simulated git apply failure' });
  try {
    const before = gitWorktree._getActiveWorktreeCountForTests('job');
    const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/carry-over of base WIP failed/);
    expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(before);
    const list = git(['worktree', 'list', '--porcelain'], repoCwd);
    expect(list).not.toContain('sm-job/x');
  } finally {
    spy.mockRestore();
  }
});

// ──────────────────────────────────────────── PRD: stream the base-WIP diff capture (job 1192)

test('[job] a wide dirty tree (300+ changed paths incl. a multi-MB file) captures and carries over without a maxBuffer overflow', async () => {
  const files = [];
  for (let i = 0; i < 300; i++) {
    const rel = `wide-${i}.txt`;
    fs.writeFileSync(path.join(repoCwd, rel), `initial ${i}\n`, 'utf8');
    files.push(rel);
  }
  const bigRel = 'big-file.bin';
  fs.writeFileSync(path.join(repoCwd, bigRel), Buffer.alloc(1024, 1));
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'wide baseline'], repoCwd);

  // Dirty every tracked file (uncommitted tracked edits) and grow the binary
  // file well past Node's execFile default maxBuffer (1MB) — the exact shape
  // that overflowed the old buffered capture (job 1192: ~240 dirty paths).
  for (const rel of files) fs.appendFileSync(path.join(repoCwd, rel), 'dirtied\n', 'utf8');
  const bigBuf = Buffer.alloc(3 * 1024 * 1024); // 3MB of NUL bytes — git detects this as binary
  fs.writeFileSync(path.join(repoCwd, bigRel), bigBuf);

  const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'wide-tree' });
  expect(result.ok).toBe(true);
  expect(result.carriedPaths.length).toBe(files.length + 1);
  expect(fs.readFileSync(path.join(result.dir, files[0]), 'utf8')).toContain('dirtied');
  expect(Buffer.compare(fs.readFileSync(path.join(result.dir, bigRel)), bigBuf)).toBe(0);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: result.dir, branch: result.branch });
}, 30_000);

test('[job] a renamed file and a mutated binary file survive the capture/apply round trip using the same flags as production', async () => {
  const binRel = 'asset.bin';
  const binInitial = Buffer.from([0, 1, 2, 3, 4, 0, 255, 254]);
  fs.writeFileSync(path.join(repoCwd, binRel), binInitial);
  fs.writeFileSync(path.join(repoCwd, 'to-rename.txt'), 'original name content\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'binary + rename baseline'], repoCwd);

  // Dirty tree: a tracked rename plus a mutated binary file, both uncommitted.
  git(['mv', 'to-rename.txt', 'renamed.txt'], repoCwd);
  const binChanged = Buffer.from([9, 8, 7, 0, 6, 5, 0, 4]);
  fs.writeFileSync(path.join(repoCwd, binRel), binChanged);

  const result = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'rename-binary' });
  expect(result.ok).toBe(true);
  expect(fs.existsSync(path.join(result.dir, 'to-rename.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(result.dir, 'renamed.txt'), 'utf8')).toBe('original name content\n');
  expect(Buffer.compare(fs.readFileSync(path.join(result.dir, binRel)), binChanged)).toBe(0);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: result.dir, branch: result.branch });
});

test('[job] a capture that cannot write its diff file (target dir missing) falls back with a specific reason, never the old generic maxBuffer message', async () => {
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const bogusDir = path.join(tmpRoot, 'does-not-exist');
  const result = await gitWorktree.captureAndCarryBaseDiff({ cwd: repoCwd, dir: bogusDir });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/capturing base diff failed/);
  expect(result.reason).not.toMatch(/maxBuffer/i);
  expect(fs.existsSync(bogusDir)).toBe(false); // nothing leaked into a directory that never existed
});

test('[job] the temp diff file is removed after carry-over on both the success and the git-apply-failure paths', async () => {
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const success = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cleanup-ok' });
  expect(success.ok).toBe(true);
  expect(fs.readdirSync(success.dir).filter((f) => f.startsWith('.sm-worktree-carry-'))).toEqual([]);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: success.dir, branch: success.branch });

  // Force a git-apply failure on a genuine clean-base worktree by making the
  // target file read-only before the capture/apply call, so the patch writes
  // fine but applying it fails — the finally block must still remove the temp
  // patch file even though apply itself errored.
  const clean = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cleanup-fail' });
  expect(clean.ok).toBe(true);
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'another uncommitted tracked edit\n', 'utf8');
  const targetFile = path.join(clean.dir, 'README.md');
  fs.chmodSync(targetFile, 0o444);
  try {
    const fail = await gitWorktree.captureAndCarryBaseDiff({ cwd: repoCwd, dir: clean.dir });
    expect(fail.ok).toBe(false);
    expect(fail.reason).toMatch(/git apply failed/);
  } finally {
    fs.chmodSync(targetFile, 0o644);
  }
  expect(fs.readdirSync(clean.dir).filter((f) => f.startsWith('.sm-worktree-carry-'))).toEqual([]);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: clean.dir, branch: clean.branch });
}, 30_000);

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

test('[job] a leaked cap count (checkout removed from disk without cleanupWorktree) self-heals on the next createWorktree', async () => {
  process.env.SM_JOB_WORKTREE_MAX = '1';
  const first = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'leak-1' });
  expect(first.ok).toBe(true);

  // Simulate the crash/reap path: the checkout is torn off disk directly
  // (not via cleanupJobWorktree), exactly like a job that got SIGTERM'd or
  // reaped before its own teardown ran — activeWorktreeCount never gets
  // decremented, so the in-memory counter is now permanently stuck at the
  // cap even though nothing real is holding it.
  await execFileSync('git', ['worktree', 'remove', '--force', first.dir], { cwd: repoCwd, encoding: 'utf8' });
  fs.rmSync(first.dir, { recursive: true, force: true });
  expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(1);

  // Against unpatched main this next call stays wedged forever: the counter
  // never reflects that nothing is actually checked out anymore.
  const second = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'leak-2' });
  expect(second.ok).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: second.dir, branch: second.branch });
});

test('[job] reclaimTerminalJobOrphans removes a completed row\'s clean-of-real-work orphan checkout', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'orphan-clean' });
  expect(worktree.ok).toBe(true);
  // Zero commits ahead of main and nothing dirty at all in the checkout —
  // the simplest "safe to reclaim" shape.
  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['orphan-clean']),
  });
  expect(reclaimed).toEqual(['orphan-clean']);
  expect(fs.existsSync(worktree.dir)).toBe(false);
});

test('[job] reclaimTerminalJobOrphans reclaims a checkout carrying only ops-folder dirty noise', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'orphan-ops-noise' });
  expect(worktree.ok).toBe(true);
  fs.mkdirSync(path.join(worktree.dir, 'session-manager-operations'), { recursive: true });
  fs.writeFileSync(path.join(worktree.dir, 'session-manager-operations', 'queue.json'), '{}\n', 'utf8');

  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['orphan-ops-noise']),
  });
  expect(reclaimed).toEqual(['orphan-ops-noise']);
  expect(fs.existsSync(worktree.dir)).toBe(false);
});

test('[job] reclaimTerminalJobOrphans leaves a checkout with real (non-ops) dirty content alone', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'orphan-real-work' });
  expect(worktree.ok).toBe(true);
  fs.writeFileSync(path.join(worktree.dir, 'real-output.txt'), 'not ops noise\n', 'utf8');

  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['orphan-real-work']),
  });
  expect(reclaimed).toEqual([]);
  expect(fs.existsSync(worktree.dir)).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] reclaimTerminalJobOrphans leaves a checkout with unmerged commits alone', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'orphan-unmerged' });
  expect(worktree.ok).toBe(true);
  fs.writeFileSync(path.join(worktree.dir, 'new-file.txt'), 'real committed work\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'unmerged job commit'], worktree.dir);

  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['orphan-unmerged']),
  });
  expect(reclaimed).toEqual([]);
  expect(fs.existsSync(worktree.dir)).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] reclaimTerminalJobOrphans ignores a worktree whose slug is not in terminalSlugs', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'not-terminal' });
  expect(worktree.ok).toBe(true);

  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['some-other-slug']),
  });
  expect(reclaimed).toEqual([]);
  expect(fs.existsSync(worktree.dir)).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

// ──────────────────────────────────────────── PRD 1163: liveness gate in front of reclaimTerminalJobOrphans

test('[job] reclaimTerminalJobOrphans does NOT remove a checkout when an injected isLive predicate reports it live', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'terminal-but-live' });
  expect(worktree.ok).toBe(true);
  // Clean-of-real-work shape (zero commits ahead, nothing dirty) — would be
  // reclaimed by the existing two proofs alone. The liveness gate must be
  // checked BEFORE those proofs and override them.
  const isLive = vi.fn(async () => true);

  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['terminal-but-live']),
    isLive,
  });

  expect(reclaimed).toEqual([]);
  expect(fs.existsSync(worktree.dir)).toBe(true);
  expect(isLive).toHaveBeenCalledWith('terminal-but-live', expect.objectContaining({ worktree: worktree.dir }));
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] reclaimTerminalJobOrphans still removes a terminal, dead, merged, ops-only-dirty checkout when isLive reports it not live', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'terminal-and-dead' });
  expect(worktree.ok).toBe(true);
  const isLive = vi.fn(async () => false);

  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['terminal-and-dead']),
    isLive,
  });

  expect(reclaimed).toEqual(['terminal-and-dead']);
  expect(fs.existsSync(worktree.dir)).toBe(false);
  expect(isLive).toHaveBeenCalled();
});

test('[job] reclaimTerminalJobOrphans treats an isLive that throws as fail-safe (assume live, do not delete)', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'isLive-throws' });
  expect(worktree.ok).toBe(true);
  const isLive = vi.fn(async () => { throw new Error('boom'); });

  const reclaimed = await gitWorktree.reclaimTerminalJobOrphans({
    cwd: repoCwd,
    terminalSlugs: new Set(['isLive-throws']),
    isLive,
  });

  expect(reclaimed).toEqual([]);
  expect(fs.existsSync(worktree.dir)).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] jobWorktreeTerminalOrphanLive.buildTerminalOrphanIsLive skips on a live cwd holder BEFORE checking pid, and reports the reason via onLive', async () => {
  const { buildTerminalOrphanIsLive } = require('../jobWorktreeTerminalOrphanLive.cjs');
  const claudePidAlive = vi.fn(() => false); // pid check must never even matter here
  const hasLiveHolder = vi.fn(() => true);
  const onLive = vi.fn();
  const isLive = buildTerminalOrphanIsLive({
    terminalJobs: [{ slug: 'held-slug', runtime: { pid: 4242 } }],
    claudePidAlive,
    hasLiveHolder,
    cwdHolders: new Set(['/tmp/fake']),
    onLive,
  });

  const result = await isLive('held-slug', { worktree: '/tmp/fake/checkout' });

  expect(result).toBe(true);
  expect(hasLiveHolder).toHaveBeenCalledWith('/tmp/fake/checkout', expect.any(Set));
  expect(onLive).toHaveBeenCalledWith('held-slug', expect.stringContaining('live cwd holder'));
});

test('[job] jobWorktreeTerminalOrphanLive.buildTerminalOrphanIsLive falls back to the recorded pid when there is no live holder', async () => {
  const { buildTerminalOrphanIsLive } = require('../jobWorktreeTerminalOrphanLive.cjs');
  const claudePidAlive = vi.fn((pid) => pid === 4242);
  const hasLiveHolder = vi.fn(() => false);
  const onLive = vi.fn();
  const isLive = buildTerminalOrphanIsLive({
    terminalJobs: [{ slug: 'pid-slug', runtime: { pid: 4242 } }],
    claudePidAlive,
    hasLiveHolder,
    onLive,
  });

  expect(await isLive('pid-slug', { worktree: '/tmp/whatever' })).toBe(true);
  expect(onLive).toHaveBeenCalledWith('pid-slug', expect.stringContaining('pid=4242'));

  expect(await isLive('unknown-slug', { worktree: '/tmp/whatever' })).toBe(false);
});

test('[job] getMaxConcurrentWorktrees floors the job cap at the sessionSlots pool size (PRD 1112)', () => {
  const originalSlots = process.env.SM_SESSION_SLOTS;
  try {
    process.env.SM_SESSION_SLOTS = '10';
    expect(gitWorktree.getMaxConcurrentWorktrees('job')).toBe(10);

    // The floor never drops BELOW the existing default (4) even when the
    // slot pool is smaller — this cap only ever widens for isolation, never
    // narrows it below what already shipped.
    process.env.SM_SESSION_SLOTS = '3';
    expect(gitWorktree.getMaxConcurrentWorktrees('job')).toBe(4);
  } finally {
    if (originalSlots === undefined) delete process.env.SM_SESSION_SLOTS;
    else process.env.SM_SESSION_SLOTS = originalSlots;
  }
});

test('[job] an explicit SM_JOB_WORKTREE_MAX wins verbatim over the sessionSlots floor', () => {
  const originalSlots = process.env.SM_SESSION_SLOTS;
  try {
    process.env.SM_SESSION_SLOTS = '10';
    process.env.SM_JOB_WORKTREE_MAX = '2';
    expect(gitWorktree.getMaxConcurrentWorktrees('job')).toBe(2);
  } finally {
    if (originalSlots === undefined) delete process.env.SM_SESSION_SLOTS;
    else process.env.SM_SESSION_SLOTS = originalSlots;
  }
});

test('[epic] getMaxConcurrentWorktrees is unaffected by the sessionSlots pool size', () => {
  const originalSlots = process.env.SM_SESSION_SLOTS;
  try {
    process.env.SM_SESSION_SLOTS = '10';
    expect(gitWorktree.getMaxConcurrentWorktrees('epic')).toBe(50);
  } finally {
    if (originalSlots === undefined) delete process.env.SM_SESSION_SLOTS;
    else process.env.SM_SESSION_SLOTS = originalSlots;
  }
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

// ──────────────────────────────────────────── PRD 1162: job-kind isLive gate
// (a job survives an app restart via detached:true, so a worktree found at
// boot is not by itself proof its run already died — see scheduler.cjs's
// boot sweep + jobWorktreeBootLive.cjs, exercised here at the
// reconcileWorktreesOnBoot layer with a fully injected isLive predicate).

test('[job] reconcileWorktreesOnBoot removes a job worktree with no live holder and no running row', async () => {
  const slug = 'test-slug-dead';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);

  const isLive = vi.fn(() => false);
  await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job', isLive });

  expect(fs.existsSync(worktree.dir)).toBe(false);
  expect(isLive).toHaveBeenCalledWith(slug, expect.objectContaining({ worktree: worktree.dir }));
});

test('[job] reconcileWorktreesOnBoot SKIPS a worktree whose row is running with a live pid', async () => {
  const slug = 'test-slug-running-live';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);

  const isLive = (key) => key === slug;
  const result = await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job', isLive });

  expect(fs.existsSync(worktree.dir)).toBe(true);
  expect(result.checkoutsRemoved).toBe(0);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] reconcileWorktreesOnBoot SKIPS a worktree whose row is absent/terminal but a live cwd holder is reported', async () => {
  const slug = 'test-slug-terminal-holder';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);

  // Row is absent from the caller's bookkeeping entirely (as if the queue row
  // already went terminal) — only the injected cwd-holder signal says live.
  const isLive = (key, entry) => entry.worktree === worktree.dir;
  const result = await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job', isLive });

  expect(fs.existsSync(worktree.dir)).toBe(true);
  expect(result.checkoutsRemoved).toBe(0);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

// ──────────────────────────────────────────── PRD 1162: hasLiveHolder / listCwdHolders

test('hasLiveHolder returns true for the current process own cwd', () => {
  if (process.platform !== 'linux') return; // darwin has no /proc — covered by the pid-based gate instead
  expect(gitWorktree.hasLiveHolder(process.cwd())).toBe(true);
});

test('hasLiveHolder returns false for a freshly-created empty temp dir nothing holds as cwd', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hasLiveHolder-empty-'));
  try {
    expect(gitWorktree.hasLiveHolder(emptyDir)).toBe(false);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('hasLiveHolder never throws for a non-existent path', () => {
  expect(() => gitWorktree.hasLiveHolder('/definitely/does/not/exist/anywhere')).not.toThrow();
  expect(gitWorktree.hasLiveHolder('/definitely/does/not/exist/anywhere')).toBe(false);
});

test('hasLiveHolder still matches a checkout dir whose /proc readlink shows the "(deleted)" suffix (unlinked while a process still held it as cwd)', async () => {
  if (process.platform !== 'linux') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hasLiveHolder-deleted-'));
  const child = spawn('sleep', ['5'], { cwd: dir, stdio: 'ignore' });
  try {
    // Give the child a moment to actually chdir before the dir is unlinked.
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(gitWorktree.hasLiveHolder(dir)).toBe(true);
  } finally {
    child.kill();
  }
});

test('hasLiveHolder accepts a precomputed holders Set from listCwdHolders() and matches a path nested under a holder', () => {
  if (process.platform !== 'linux') return; // darwin: hasLiveHolder always false, per its own contract
  const holders = new Set(['/tmp/some-worktree-checkout']);
  expect(gitWorktree.hasLiveHolder('/tmp/some-worktree-checkout/nested/deep', holders)).toBe(false);
  expect(gitWorktree.hasLiveHolder('/tmp/some-worktree-checkout', holders)).toBe(true);
});

test('listCwdHolders returns a Set and includes the current process own cwd on linux', () => {
  const holders = gitWorktree.listCwdHolders();
  expect(holders).toBeInstanceOf(Set);
  if (process.platform === 'linux') {
    expect(holders.has(path.resolve(process.cwd()))).toBe(true);
  } else {
    expect(holders.size).toBe(0);
  }
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

// ──────────────────────────────────────────── isBaseTreeClean (PRD 1064)

test('isBaseTreeClean ignores untracked files — a single stray untracked file must not disable isolation', async () => {
  fs.writeFileSync(path.join(repoCwd, 'scratch_untracked.txt'), 'not tracked\n', 'utf8');
  expect(await gitWorktree.isBaseTreeClean(repoCwd)).toBe(true);
});

test('isBaseTreeClean still reports dirty for a modified TRACKED file', async () => {
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'modified tracked content\n', 'utf8');
  expect(await gitWorktree.isBaseTreeClean(repoCwd)).toBe(false);
});

// ──────────────────────────────────────────── orphaned on-disk checkouts (PRD 1108)

test('[job] cleanupWorktree rmdirs the now-empty parent hash dir, but a sibling checkout in the same hash dir survives', async () => {
  const first = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'sibling-a' });
  const second = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'sibling-b' });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  const hashDir = path.dirname(first.dir);
  expect(path.dirname(second.dir)).toBe(hashDir);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: first.dir, branch: first.branch });
  expect(fs.existsSync(first.dir)).toBe(false);
  // The hash dir must survive — the sibling checkout still lives under it.
  expect(fs.existsSync(hashDir)).toBe(true);
  expect(fs.existsSync(second.dir)).toBe(true);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: second.dir, branch: second.branch });
  expect(fs.existsSync(second.dir)).toBe(false);
  // Now that the last sibling is gone, the empty hash dir is reclaimed too.
  expect(fs.existsSync(hashDir)).toBe(false);
});

test('[job] reconcileWorktreesOnBoot reclaims an orphaned on-disk checkout for a project cwd it was never handed', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'orphan-old' });
  expect(worktree.ok).toBe(true);
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
  // Simulate age: back-date the checkout dir's mtime well past the 1s
  // threshold used below, without touching anything about its content.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(worktree.dir, old, old);

  // No cwd handed in at all — this is the "project no longer tracked" case
  // the per-cwd loop can never reach on its own.
  await gitWorktree.reconcileWorktreesOnBoot([], { kind: 'job', staleAgeMs: 1_000 });

  expect(fs.existsSync(worktree.dir)).toBe(false);
  // The hash dir it lived under is empty now and must be reclaimed too.
  expect(fs.existsSync(path.dirname(worktree.dir))).toBe(false);
  // The main tree's own worktree registration must not be left dangling.
  const list = git(['worktree', 'list', '--porcelain'], repoCwd);
  expect(list).not.toContain(worktree.dir);
});

test('[job] reconcileWorktreesOnBoot never reclaims a fresh, in-use checkout younger than the age threshold', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'fresh-in-use' });
  expect(worktree.ok).toBe(true);
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);

  await gitWorktree.reconcileWorktreesOnBoot([], { kind: 'job', staleAgeMs: 24 * 60 * 60 * 1000 });

  expect(fs.existsSync(worktree.dir)).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[epic] the orphan sweep age threshold defaults much higher (7 days) than the job kind (24h)', () => {
  expect(gitWorktree.getStaleSweepAgeMs('job')).toBe(24 * 60 * 60 * 1000);
  expect(gitWorktree.getStaleSweepAgeMs('epic')).toBe(7 * 24 * 60 * 60 * 1000);
});

test('[epic] SM_EPIC_WORKTREE_STALE_MS overrides the epic orphan-sweep age threshold independently of the job env var', () => {
  const original = process.env.SM_EPIC_WORKTREE_STALE_MS;
  try {
    process.env.SM_EPIC_WORKTREE_STALE_MS = '12345';
    expect(gitWorktree.getStaleSweepAgeMs('epic')).toBe(12345);
    expect(gitWorktree.getStaleSweepAgeMs('job')).toBe(24 * 60 * 60 * 1000);
  } finally {
    if (original === undefined) delete process.env.SM_EPIC_WORKTREE_STALE_MS;
    else process.env.SM_EPIC_WORKTREE_STALE_MS = original;
  }
});

test('[job] sweepStaleWorktreeCheckouts treats staleAgeMs: 0 as "reclaim immediately", not as "unset — use the default"', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'zero-age' });
  expect(worktree.ok).toBe(true);
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);

  const result = await gitWorktree.sweepStaleWorktreeCheckouts('job', { staleAgeMs: 0 });

  expect(result.checkoutsRemoved).toBe(1);
  expect(fs.existsSync(worktree.dir)).toBe(false);
});

test('[job] sweepStaleWorktreeCheckouts does NOT remove an old-mtime checkout with a live holder, regardless of age', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'stale-but-live' });
  expect(worktree.ok).toBe(true);
  const holders = new Set([path.resolve(worktree.dir)]);

  const result = await gitWorktree.sweepStaleWorktreeCheckouts('job', { staleAgeMs: 0, holders });

  expect(result.checkoutsRemoved).toBe(0);
  expect(fs.existsSync(worktree.dir)).toBe(true);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] sweepStaleWorktreeCheckouts removes an old-mtime checkout when there is no live holder', async () => {
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'stale-and-dead' });
  expect(worktree.ok).toBe(true);
  // A populated holders set (some unrelated live cwd) that does not cover this checkout —
  // exercises the liveness gate for real instead of defeating it with an empty set.
  const holders = new Set([path.resolve(tmpRoot, 'unrelated-live-holder')]);

  const result = await gitWorktree.sweepStaleWorktreeCheckouts('job', { staleAgeMs: 0, holders });

  expect(result.checkoutsRemoved).toBe(1);
  expect(fs.existsSync(worktree.dir)).toBe(false);
});

test('[job] sweepStaleWorktreeCheckouts never deletes anything outside its own kind root, even via a symlink shaped like a traversal', async () => {
  const outsideDir = path.join(tmpRoot, 'outside-root');
  fs.mkdirSync(outsideDir, { recursive: true });
  const markerFile = path.join(outsideDir, 'do-not-delete.txt');
  fs.writeFileSync(markerFile, 'still here\n', 'utf8');

  const root = gitWorktree.worktreeRootFor('job');
  const hashDir = path.join(root, 'traversal-hash-dir');
  fs.mkdirSync(hashDir, { recursive: true });
  const escapePath = path.join(hashDir, 'escape');
  fs.symlinkSync(outsideDir, escapePath, 'dir');

  const result = await gitWorktree.sweepStaleWorktreeCheckouts('job', { staleAgeMs: 0 });

  expect(fs.existsSync(markerFile)).toBe(true);
  expect(fs.existsSync(outsideDir)).toBe(true);
  expect(result.checkoutsRemoved).toBe(0);

  fs.rmSync(hashDir, { recursive: true, force: true });
});

test('[job] reconcileWorktreesOnBoot logs a one-shot report line with reclaimed counts', async () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await gitWorktree.reconcileWorktreesOnBoot([repoCwd], { kind: 'job' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/boot sweep \(kind:job\): reclaimed \d+ checkout\(s\), \d+ empty root dir\(s\)/));
  } finally {
    logSpy.mockRestore();
  }
});

// ──────────────────────────────────────────── PRD 1125: auto-resolve identical-duplicate merge blocks

test('[job] integrateBranch auto-resolves when every blocking path (tracked + untracked) is byte-identical to the branch', async () => {
  const slug = 'test-slug-identical-duplicates';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  // The job's own real work, committed on its branch.
  fs.writeFileSync(path.join(worktree.dir, 'fileA'), 'shared-value\n', 'utf8');
  fs.mkdirSync(path.join(worktree.dir, 'newdir'), { recursive: true });
  fs.writeFileSync(path.join(worktree.dir, 'newdir', 'fileU'), 'untracked-shared-value\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  // The shared main tree independently ends up with the SAME bytes on both
  // a tracked path (dirty, uncommitted) and an untracked path — exactly the
  // 2026-09-06 starry-night-ships incident shape: a prior in-place run left
  // these duplicates behind uncommitted.
  fs.writeFileSync(path.join(repoCwd, 'fileA'), 'shared-value\n', 'utf8');
  fs.mkdirSync(path.join(repoCwd, 'newdir'), { recursive: true });
  fs.writeFileSync(path.join(repoCwd, 'newdir', 'fileU'), 'untracked-shared-value\n', 'utf8');

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);
  expect(outcome.mergeCommit ?? outcome.fastForward).toBeTruthy();
  expect(outcome.autoResolved).toBe('identical_working_tree_duplicates');
  expect(outcome.resolvedPaths.sort()).toEqual(['fileA', 'newdir/fileU'].sort());

  expect(fs.readFileSync(path.join(repoCwd, 'fileA'), 'utf8')).toBe('shared-value\n');
  expect(fs.readFileSync(path.join(repoCwd, 'newdir', 'fileU'), 'utf8')).toBe('untracked-shared-value\n');
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: !outcome.ok });
});

test('[job] integrateBranch does NOT auto-resolve when one blocking path differs from the branch — same reason as today', async () => {
  const slug = 'test-slug-one-differing-path';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'fileA'), 'branch-value\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  // Main tree's dirty copy diverges from the branch's committed content —
  // real information is at risk, so this must NOT be discarded.
  fs.writeFileSync(path.join(repoCwd, 'fileA'), 'different-local-value\n', 'utf8');

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toMatch(/merge failed \(likely a real content conflict\)/);
  expect(fs.readFileSync(path.join(repoCwd, 'fileA'), 'utf8')).toBe('different-local-value\n');
  expect(git(['status', '--porcelain'], repoCwd).trim()).not.toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

test('[job] integrateBranch falls through to today\'s failure when stderr has no parseable blocking-path block (a genuine content conflict)', async () => {
  const slug = 'test-slug-unparseable-stderr';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'job edit\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job edits README'], worktree.dir);

  // A committed (not dirty) diverging edit on the main tree produces git's
  // ordinary "CONFLICT (content)" stderr shape, not the "would be
  // overwritten" block parseBlockingMergePaths looks for.
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'main tree edit\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main tree edits README'], repoCwd);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toMatch(/merge failed \(likely a real content conflict\)/);
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

test('[job] integrateBranch aborts cleanly when the single retry also fails on a genuine conflict elsewhere', async () => {
  const slug = 'test-slug-retry-fails';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  // The branch's own real work: extends fileA (existing, tracked since
  // initRepo's README.md commit doesn't cover it — add it fresh here) and
  // ADDS a brand-new fileB.txt.
  fs.writeFileSync(path.join(worktree.dir, 'fileA'), 'shared-value\n', 'utf8');
  fs.writeFileSync(path.join(worktree.dir, 'fileB.txt'), 'branch B change\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit: fileA + fileB'], worktree.dir);

  // Main tree independently ADDS the SAME path with DIFFERENT content — a
  // genuine "both added, diverging content" conflict on fileB.txt.
  fs.writeFileSync(path.join(repoCwd, 'fileB.txt'), 'base B change\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main tree diverges fileB'], repoCwd);
  // ...and ALSO leaves fileA dirty with content byte-identical to the branch
  // — the one blocking path the initial merge attempt refuses on, and the
  // one the auto-resolve retry successfully discards.
  fs.writeFileSync(path.join(repoCwd, 'fileA'), 'shared-value\n', 'utf8');

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toMatch(/merge failed \(likely a real content conflict\)/);
  // The retry's half-applied merge must be aborted, not left mid-merge.
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');
  expect(fs.existsSync(path.join(repoCwd, '.git', 'MERGE_HEAD'))).toBe(false);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

// ──────────────────────────────────────────── default-branch integration guard (PRD: starry-night-ships wrong-base merges)

test('[guard] integrateBranch proceeds normally when HEAD is on the repo default branch', async () => {
  const slug = 'test-slug-guard-default-ok';
  const defaultBranch = git(['symbolic-ref', '--short', 'HEAD'], repoCwd).trim();
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'guard-ok.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe(defaultBranch);
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[guard] integrateBranch refuses when HEAD is on a stray sm-job/* branch, naming both branches in the reason, and mutates nothing', async () => {
  const defaultBranch = git(['symbolic-ref', '--short', 'HEAD'], repoCwd).trim();
  const slugB = 'test-slug-guard-stray-b';
  const strayBranch = 'sm-job/leftover-from-a-prior-run';
  const worktreeB = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: slugB });
  fs.writeFileSync(path.join(worktreeB.dir, 'guard-stray.txt'), 'branch b output\n', 'utf8');
  git(['add', '-A'], worktreeB.dir);
  git(['commit', '-q', '-m', 'job commit b'], worktreeB.dir);

  // Simulate the live incident: the SHARED tree's own HEAD got checked out
  // onto a leftover job branch instead of staying on the default branch.
  git(['checkout', '-b', strayBranch], repoCwd);
  const headBefore = git(['rev-parse', 'HEAD'], repoCwd).trim();
  const statusBefore = git(['status', '--porcelain'], repoCwd);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktreeB.branch, slug: slugB });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toContain(defaultBranch);
  expect(outcome.reason).toContain(strayBranch);

  // Refusing must not touch git state: no checkout/reset/switch performed.
  expect(git(['rev-parse', 'HEAD'], repoCwd).trim()).toBe(headBefore);
  expect(git(['status', '--porcelain'], repoCwd)).toBe(statusBefore);

  git(['checkout', defaultBranch], repoCwd);
  git(['branch', '-D', strayBranch], repoCwd);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktreeB.dir, branch: worktreeB.branch, keepBranch: true });
  try { git(['branch', '-D', worktreeB.branch], repoCwd); } catch { /* best-effort */ }
});

test('[guard] integrateBranch refuses on a detached HEAD, reporting "detached HEAD" rather than treating it as a branch', async () => {
  const defaultBranch = git(['symbolic-ref', '--short', 'HEAD'], repoCwd).trim();
  const slug = 'test-slug-guard-detached';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  fs.writeFileSync(path.join(worktree.dir, 'guard-detached.txt'), 'output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  const headSha = git(['rev-parse', 'HEAD'], repoCwd).trim();
  git(['checkout', '--detach', headSha], repoCwd);
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBeNull();

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toContain('detached HEAD');
  expect(outcome.reason).toContain(defaultBranch);

  git(['checkout', defaultBranch], repoCwd);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  try { git(['branch', '-D', worktree.branch], repoCwd); } catch { /* best-effort */ }
});

test('[guard] resolveDefaultBranch resolves a sensible default (the sole local branch) for a repo with no remote, and integration still proceeds', async () => {
  const remoteOut = execFileSync('git', ['remote'], { cwd: repoCwd, encoding: 'utf8' }).trim();
  expect(remoteOut).toBe('');
  const defaultBranch = git(['symbolic-ref', '--short', 'HEAD'], repoCwd).trim();
  expect(await gitWorktree.resolveDefaultBranch(repoCwd)).toBe(defaultBranch);

  const slug = 'test-slug-guard-no-remote';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  fs.writeFileSync(path.join(worktree.dir, 'guard-no-remote.txt'), 'output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[guard][epic] integrateEpicBranch inherits the same guard and still merges cleanly when HEAD is on the default branch', async () => {
  const epicId = 'test-epic-guard-ok';
  const worktree = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'epic-guard.txt'), 'epic output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'epic commit'], worktree.dir);

  const outcome = await gitWorktree.integrateEpicBranch({ cwd: repoCwd, branch: worktree.branch, epicId });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);

  await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

// ── integrateBranch failure subtype classification (mc-01) ──

test('[job] integrateBranch classifies a dirty different tracked file as failureKind blocking_paths', async () => {
  const slug = 'test-slug-kind-blocking';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'job edit\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job edits README'], worktree.dir);
  // Dirty (uncommitted), byte-DIFFERENT edit in the main tree blocks the merge.
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'different local edit\n', 'utf8');

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toMatch(/merge failed \(likely a real content conflict\)/);
  expect(outcome.failureKind).toBe('blocking_paths');
  expect(outcome.blockingPaths.tracked).toEqual(['README.md']);
  expect(outcome.blockingPaths.untracked).toEqual([]);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

test('[job] integrateBranch classifies diverging same-line commits as content_conflict with the conflicted path', async () => {
  const slug = 'test-slug-kind-content';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'job edit\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job edits README'], worktree.dir);
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'main tree edit\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main tree edits README'], repoCwd);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('content_conflict');
  expect(outcome.conflictedPaths).toEqual(['README.md']);
  // The abort still ran.
  expect(fs.existsSync(path.join(repoCwd, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

test('[job] integrateBranch classifies disjoint appends to the END of one file as content_conflict when the path is not allowlisted (.js)', async () => {
  const slug = 'test-slug-kind-append';
  fs.writeFileSync(path.join(repoCwd, 'src.js'), '// intro\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'add src.js'], repoCwd);
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.appendFileSync(path.join(worktree.dir, 'src.js'), '\n// Section Six\nsix body\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job appends section six'], worktree.dir);
  fs.appendFileSync(path.join(repoCwd, 'src.js'), '\n## Section Seven\nseven body\n\n## Section Ten\nten body\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main appends sections seven and ten'], repoCwd);

  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('content_conflict');
  expect(outcome.conflictedPaths).toEqual(['src.js']);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

// ── pure-addition merge-conflict auto-resolve (mc-02) ──

async function conflictScenario(slug, { base, side, main }) {
  for (const [f, c] of Object.entries(base)) {
    fs.mkdirSync(path.dirname(path.join(repoCwd, f)), { recursive: true });
    fs.writeFileSync(path.join(repoCwd, f), c, 'utf8');
  }
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'base files'], repoCwd);
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);
  for (const [f, c] of Object.entries(side)) {
    fs.mkdirSync(path.dirname(path.join(worktree.dir, f)), { recursive: true });
    fs.writeFileSync(path.join(worktree.dir, f), c, 'utf8');
  }
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job side'], worktree.dir);
  for (const [f, c] of Object.entries(main)) {
    fs.mkdirSync(path.dirname(path.join(repoCwd, f)), { recursive: true });
    fs.writeFileSync(path.join(repoCwd, f), c, 'utf8');
  }
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main side'], repoCwd);
  return worktree;
}

const MARKER_RE = /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/m;

test('[job] integrateBranch auto-resolves a pure-addition .md conflict by concatenating ours then theirs', async () => {
  const slug = 'test-slug-pure-add';
  const worktree = await conflictScenario(slug, {
    base: { 'd.md': '# Doc\n\nintro\n' },
    side: { 'd.md': '# Doc\n\nintro\n\n## Section A\na body\n' },
    main: { 'd.md': '# Doc\n\nintro\n\n## Section B\nb body\n\n## Section C\nc body\n' },
  });
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.autoResolved).toBe('pure_addition_concat');
  expect(outcome.resolvedPaths).toEqual(['d.md']);
  const merged = fs.readFileSync(path.join(repoCwd, 'd.md'), 'utf8');
  expect(merged).toBe('# Doc\n\nintro\n\n## Section B\nb body\n\n## Section C\nc body\n\n## Section A\na body\n');
  expect(merged).not.toMatch(MARKER_RE);
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');
  expect(git(['log', '-1', '--format=%s'], repoCwd).trim()).toBe(`merge scheduler job ${slug}`);
  expect(git(['rev-list', '--parents', '-n', '1', 'HEAD'], repoCwd).trim().split(' ').length).toBe(3);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('[job] integrateBranch does NOT auto-resolve a same-line .md edit and leaves the tree clean', async () => {
  const slug = 'test-slug-pure-add-neg-sameline';
  const worktree = await conflictScenario(slug, {
    base: { 'd.md': 'intro\nORIGINAL LINE\n' },
    side: { 'd.md': 'intro\nSIDE EDIT\n' },
    main: { 'd.md': 'intro\nMAIN EDIT\n' },
  });
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.autoResolved).toBeUndefined();
  expect(outcome.failureKind).toBe('content_conflict');
  expect(outcome.conflictedPaths).toEqual(['d.md']);
  expect(fs.readFileSync(path.join(repoCwd, 'd.md'), 'utf8')).toBe('intro\nMAIN EDIT\n');
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

test('[job] integrateBranch does NOT auto-resolve a pure-addition conflict on a non-allowlisted path', async () => {
  const slug = 'test-slug-pure-add-neg-js';
  const worktree = await conflictScenario(slug, {
    base: { 'src/thing.js': '// intro\n' },
    side: { 'src/thing.js': '// intro\n// A\n' },
    main: { 'src/thing.js': '// intro\n// B\n// C\n' },
  });
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.autoResolved).toBeUndefined();
  expect(outcome.failureKind).toBe('content_conflict');
  expect(fs.readFileSync(path.join(repoCwd, 'src/thing.js'), 'utf8')).toBe('// intro\n// B\n// C\n');
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});

test('[job] integrateBranch bails the whole merge when only some conflicted paths are provable (mixed .md + .js)', async () => {
  const slug = 'test-slug-pure-add-neg-mixed';
  const worktree = await conflictScenario(slug, {
    base: { 'd.md': 'intro\n', 'src/thing.js': 'ORIGINAL\n' },
    side: { 'd.md': 'intro\n## A\n', 'src/thing.js': 'SIDE\n' },
    main: { 'd.md': 'intro\n## B\n', 'src/thing.js': 'MAIN\n' },
  });
  const outcome = await gitWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.autoResolved).toBeUndefined();
  expect(outcome.conflictedPaths).toEqual(['d.md', 'src/thing.js']);
  expect(fs.readFileSync(path.join(repoCwd, 'd.md'), 'utf8')).toBe('intro\n## B\n');
  expect(fs.readFileSync(path.join(repoCwd, 'src/thing.js'), 'utf8')).toBe('MAIN\n');
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');
  expect(fs.existsSync(path.join(repoCwd, '.git', 'MERGE_HEAD'))).toBe(false);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
});
