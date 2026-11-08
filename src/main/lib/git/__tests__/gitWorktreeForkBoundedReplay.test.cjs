/**
 * gitWorktreeForkBoundedReplay.test.cjs — `sinceSha` on `replayBranchOnto` and
 * `isBranchContentLanded`. When the base branch is rewritten (rebase/reset)
 * while a job runs, the job branch still carries the pre-rewrite base commits
 * it forked from; their rebased copies differ in patch-id, so an unbounded
 * replay re-applies them and conflicts. Bounding the range at the fork commit
 * (`^<sinceSha>`) replays only the job's own commits (Bilko incident
 * 2026-11-08, job 1716-fix).
 *
 * Real git plumbing against throwaway repos under os.tmpdir().
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/gitWorktreeForkBoundedReplay.test.cjs
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
let B;
let P;
let J;
let P2;

function git(args, cwd = repoCwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const lines = (overrides = {}) =>
  Array.from({ length: 10 }, (_, i) => overrides[i + 1] ?? `l${i + 1}`).join('\n') + '\n';

function commit(file, content, msg) {
  fs.writeFileSync(path.join(repoCwd, file), content, 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']).trim();
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-fork-bounded-'));
  repoCwd = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoCwd, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  B = commit('s.txt', lines(), 'base');
  P = commit('s.txt', lines({ 5: 'P' }), 'main: line 5 -> P');
  git(['checkout', '-q', '-b', 'job']);
  J = commit('j.txt', 'job\n', 'feat: job work');
  git(['checkout', '-q', 'main']);
  // Rewrite main underneath the job: as if P was rebased onto an upstream U
  // and its conflict resolved to "U+P".
  git(['reset', '-q', '--hard', B]);
  commit('s.txt', lines({ 5: 'U' }), 'upstream: line 5 -> U');
  P2 = commit('s.txt', lines({ 5: 'U+P' }), 'main: line 5 -> P (rebased)');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('without sinceSha the replay re-applies the pre-rewrite base commit and conflicts', async () => {
  const r = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: P2, branch: 'job' });
  expect(r.ok).toBe(false);
  expect(r.failureKind).toBe('content_conflict');
  expect(r.conflictedPaths).toEqual(['s.txt']);
});

test('with sinceSha = fork commit the replay holds only the job commit', async () => {
  const r = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: P2, branch: 'job', sinceSha: P });
  expect(r.ok).toBe(true);
  expect(r.fastForward).toBeUndefined();
  expect(r.replayed.map((x) => x.from)).toEqual([J]);
  expect(r.skipped).toEqual([]);
  expect(git(['rev-parse', `${r.tipSha}^1`]).trim()).toBe(P2);
  expect(git(['log', '-1', '--format=%s', r.tipSha]).trim()).toBe('feat: job work');
  expect(git(['show', `${r.tipSha}:s.txt`])).toBe(lines({ 5: 'U+P' }));
  expect(git(['show', `${r.tipSha}:j.txt`])).toBe('job\n');
});

test('an unusable sinceSha (empty, unknown, not an ancestor) behaves as omitted', async () => {
  for (const sinceSha of ['', 'no-such-ref', P2, undefined]) {
    const r = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: P2, branch: 'job', sinceSha });
    expect(r.ok).toBe(false);
    expect(r.failureKind).toBe('content_conflict');
  }
});

test('a merge commit in the bounded range is proved against --merge-base=<sinceSha>', async () => {
  git(['checkout', '-q', 'job']);
  git(['checkout', '-q', '-b', 'side']);
  commit('k.txt', 'side\n', 'side work');
  git(['checkout', '-q', 'job']);
  git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  git(['checkout', '-q', 'main']);
  const unbounded = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: P2, branch: 'job' });
  expect(unbounded.ok).toBe(false);
  const r = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: P2, branch: 'job', sinceSha: P });
  expect(r.ok).toBe(true);
  expect(r.replayed).toHaveLength(2);
  expect(git(['show', `${r.tipSha}:s.txt`])).toBe(lines({ 5: 'U+P' }));
  expect(git(['show', `${r.tipSha}:k.txt`])).toBe('side\n');
});

test('isBranchContentLanded with sinceSha: unlanded, landed after replay, and zero-commit branch', async () => {
  expect(await gitWorktree.isBranchContentLanded({ cwd: repoCwd, base: P2, branch: 'job', sinceSha: P })).toBe(false);

  const r = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: P2, branch: 'job', sinceSha: P });
  expect(r.ok).toBe(true);
  expect(await gitWorktree.isBranchContentLanded({ cwd: repoCwd, base: r.tipSha, branch: 'job', sinceSha: P })).toBe(true);
  // Without the bound the pre-rewrite P still reads as unlanded content.
  expect(await gitWorktree.isBranchContentLanded({ cwd: repoCwd, base: r.tipSha, branch: 'job' })).toBe(false);

  git(['branch', 'empty-job', P]);
  expect(await gitWorktree.isBranchContentLanded({ cwd: repoCwd, base: P2, branch: 'empty-job', sinceSha: P })).toBe(true);
  expect(await gitWorktree.isBranchContentLanded({ cwd: repoCwd, base: P2, branch: 'empty-job' })).toBe(false);
});
