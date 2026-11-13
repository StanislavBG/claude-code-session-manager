/**
 * epicReviewPins.test.cjs — pinEpicReviewRange / listEpicReviewRanges: an
 * Epic's fork point and tip are pinned under refs/sm-epic-review/<epicId>/<tip>/
 * {base,head} before its branch is deleted, so the Changes view can still diff
 * a completed Epic.
 *
 * Real git plumbing against throwaway repos under os.tmpdir().
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/epicReviewPins.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');
const { EPIC_REVIEW_REF_PREFIX } = require('../gitExec.cjs');

let tmpRoot;
let repoCwd;

function git(args, cwd = repoCwd, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function commit(file, content, msg, cwd = repoCwd, date) {
  fs.writeFileSync(path.join(cwd, file), content, 'utf8');
  git(['add', '-A'], cwd);
  const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : undefined;
  git(['commit', '-q', '-m', msg], cwd, env);
  return git(['rev-parse', 'HEAD'], cwd).trim();
}

/** Creates sm-epic/<epicId> with a linked checkout, the way createWorktree does. */
function addEpicWorktree(epicId) {
  const branch = `sm-epic/${epicId}`;
  const dir = path.join(tmpRoot, `wt-${epicId}`);
  git(['worktree', 'add', '-q', '-b', branch, dir, 'main']);
  return { branch, dir };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-epic-review-'));
  repoCwd = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoCwd, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  commit('a.txt', 'a\n', 'initial');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('EPIC_REVIEW_REF_PREFIX lives outside refs/heads', () => {
  expect(EPIC_REVIEW_REF_PREFIX).toBe('refs/sm-epic-review/');
});

test('a 2-commit Epic pins a range whose diff equals the branch diff and survives branch deletion + gc', async () => {
  const { branch, dir } = addEpicWorktree('ep-two');
  commit('one.txt', '1\n', 'one', dir);
  const tip = commit('two.txt', '2\n', 'two', dir);
  // main moves on after the fork — the pinned base must still be the fork.
  commit('main-only.txt', 'm\n', 'main moves');
  const branchDiff = git(['diff', `main...${branch}`]);

  const pinned = await gitWorktree.pinEpicReviewRange({ cwd: repoCwd, branch, dir });
  expect(pinned.ok).toBe(true);
  expect(pinned.head).toBe(tip);

  git(['worktree', 'remove', '--force', dir]);
  git(['branch', '-D', branch]);
  git(['reflog', 'expire', '--expire=now', '--all']);
  git(['gc', '-q', '--prune=now']);

  const ranges = await gitWorktree.listEpicReviewRanges({ cwd: repoCwd, epicId: 'ep-two' });
  expect(ranges).toHaveLength(1);
  expect(ranges[0].base).toBe(pinned.base);
  expect(ranges[0].head).toBe(tip);
  expect(typeof ranges[0].headCommittedAt).toBe('string');
  expect(git(['diff', ranges[0].base, ranges[0].head])).toBe(branchDiff);
  expect(git(['for-each-ref', '--format=%(refname)', `${EPIC_REVIEW_REF_PREFIX}ep-two/`]).trim().split('\n').sort())
    .toEqual([`${EPIC_REVIEW_REF_PREFIX}ep-two/${tip}/base`, `${EPIC_REVIEW_REF_PREFIX}ep-two/${tip}/head`]);
});

test('an uncommitted-only Epic pins a snapshot whose diff shows its edits, leaving the checkout untouched', async () => {
  const { branch, dir } = addEpicWorktree('ep-dirty');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n', 'utf8');

  const pinned = await gitWorktree.pinEpicReviewRange({ cwd: repoCwd, branch, dir });
  expect(pinned.ok).toBe(true);

  const names = git(['diff', '--name-only', pinned.base, pinned.head]).trim().split('\n').sort();
  expect(names).toEqual(['a.txt', 'new.txt']);
  expect(git(['diff', pinned.base, pinned.head])).toContain('+edited');
  // Checkout untouched: edits still uncommitted.
  expect(git(['status', '--porcelain'], dir)).toContain('new.txt');
  expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('edited\n');
});

test('a 0-change Epic pins nothing', async () => {
  const { branch, dir } = addEpicWorktree('ep-empty');
  const pinned = await gitWorktree.pinEpicReviewRange({ cwd: repoCwd, branch, dir });
  expect(pinned).toEqual({ ok: false, reason: 'no changes' });
  expect(await gitWorktree.listEpicReviewRanges({ cwd: repoCwd, epicId: 'ep-empty' })).toEqual([]);
});

test('two completion cycles list two ranges newest first', async () => {
  const { branch, dir } = addEpicWorktree('ep-cycles');
  const first = commit('c1.txt', '1\n', 'cycle one', dir, '2026-01-01T00:00:00Z');
  const p1 = await gitWorktree.pinEpicReviewRange({ cwd: repoCwd, branch, dir });
  const second = commit('c2.txt', '2\n', 'cycle two', dir, '2026-02-01T00:00:00Z');
  const p2 = await gitWorktree.pinEpicReviewRange({ cwd: repoCwd, branch, dir });
  expect(p1.ok && p2.ok).toBe(true);

  const ranges = await gitWorktree.listEpicReviewRanges({ cwd: repoCwd, epicId: 'ep-cycles' });
  expect(ranges.map((r) => r.head)).toEqual([second, first]);
});

test('pairs missing base or head are skipped', async () => {
  const sha = git(['rev-parse', 'HEAD']).trim();
  git(['update-ref', `${EPIC_REVIEW_REF_PREFIX}ep-half/${sha}/head`, sha]);
  expect(await gitWorktree.listEpicReviewRanges({ cwd: repoCwd, epicId: 'ep-half' })).toEqual([]);
});

test('an unsafe epicId returns [] and is refused for pinning', async () => {
  for (const bad of ['../x', '-x', 'a/b', '', '.x', 'x.lock', null]) {
    expect(await gitWorktree.listEpicReviewRanges({ cwd: repoCwd, epicId: bad })).toEqual([]);
  }
  const res = await gitWorktree.pinEpicReviewRange({ cwd: repoCwd, branch: 'sm-epic/-bad', dir: null });
  expect(res.ok).toBe(false);
  const notEpic = await gitWorktree.pinEpicReviewRange({ cwd: repoCwd, branch: 'main', dir: null });
  expect(notEpic.ok).toBe(false);
});

test('a git failure returns [] / ok:false, never throws', async () => {
  const notRepo = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(notRepo);
  expect(await gitWorktree.listEpicReviewRanges({ cwd: notRepo, epicId: 'ep' })).toEqual([]);
  const res = await gitWorktree.pinEpicReviewRange({ cwd: notRepo, branch: 'sm-epic/ep', dir: null });
  expect(res.ok).toBe(false);
});
