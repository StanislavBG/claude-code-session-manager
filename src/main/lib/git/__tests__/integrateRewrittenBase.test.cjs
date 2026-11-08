/**
 * integrateRewrittenBase.test.cjs — when the base branch was rewritten
 * (reset/rebase) while a job ran, `forkSha` bounds the landing to the job's
 * own commits: a clean replay lands linearly, a real conflict parks naming
 * the paths with no merge-commit fallback, a zero-commit branch is a no-op.
 *
 * Real throwaway repos under `os.tmpdir()`.
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/integrateRewrittenBase.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');

let tmpRoot;
let repo;
let P;

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function lines(line5) {
  const out = [];
  for (let i = 1; i <= 10; i++) out.push(i === 5 ? line5 : `l${i}`);
  return out.join('\n') + '\n';
}

function commitFile(name, body, msg) {
  fs.writeFileSync(path.join(repo, name), body, 'utf8');
  git(['add', name]);
  git(['commit', '-q', '-m', msg]);
}

/** B → P on main; job branch forks at P; main rewritten to B → U → P2. */
function setup({ jobCommit }) {
  commitFile('s.txt', lines('l5'), 'B');
  const B = git(['rev-parse', 'HEAD']);
  commitFile('s.txt', lines('P'), 'P');
  P = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', '-b', 'sm-job/rw']);
  if (jobCommit) jobCommit();
  git(['checkout', '-q', 'main']);
  git(['reset', '-q', '--hard', B]);
  commitFile('s.txt', lines('U'), 'U');
  commitFile('s.txt', lines('U+P'), 'P2');
}

const cleanJob = () => commitFile('j.txt', 'job\n', 'feat: job work');
const conflictJob = () => commitFile('s.txt', lines('J'), 'feat: job edits line 5');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-rewritten-base-'));
  repo = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('clean job commit lands linearly on the rewritten base', async () => {
  setup({ jobCommit: cleanJob });
  const p2 = git(['rev-parse', 'HEAD']);
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P });
  expect(res.ok).toBe(true);
  expect(res.integrated).toBe(true);
  expect(res.linear).toBe(true);
  expect(res.replayedCommits).toBe(1);
  expect(git(['rev-parse', 'HEAD'])).toBe(res.sha);
  expect(git(['rev-parse', 'HEAD^'])).toBe(p2);
  expect(git(['log', '-1', '--format=%s'])).toBe('feat: job work');
  expect(git(['rev-list', '--merges', 'HEAD'])).toBe('');
  expect(fs.readFileSync(path.join(repo, 's.txt'), 'utf8').split('\n')[4]).toBe('U+P');
  expect(fs.readFileSync(path.join(repo, 'j.txt'), 'utf8')).toBe('job\n');
});

test('conflicting job commit parks as content_conflict with no merge fallback', async () => {
  setup({ jobCommit: conflictJob });
  const before = git(['rev-parse', 'HEAD']);
  const tip = git(['rev-parse', 'sm-job/rw']);
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P });
  expect(res.ok).toBe(false);
  expect(res.failureKind).toBe('content_conflict');
  expect(res.conflictedPaths).toEqual(['s.txt']);
  expect(res.baseRewritten).toBe(true);
  expect(res.baseHeadSha).toBe(before);
  expect(res.reason).toContain('s.txt');
  expect(git(['rev-parse', 'HEAD'])).toBe(before);
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(git(['rev-parse', 'sm-job/rw'])).toBe(tip);
  expect(git(['status', '--porcelain'])).toBe('');
});

test('zero-commit branch at the fork is a no-op', async () => {
  setup({ jobCommit: null });
  const before = git(['rev-parse', 'HEAD']);
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P });
  expect(res).toEqual({ ok: true, integrated: false, reason: 'branch has no new commits' });
  expect(git(['rev-parse', 'HEAD'])).toBe(before);
});

test('zero-commit branch is a no-op on the ref-landing path too', async () => {
  setup({ jobCommit: null });
  const before = git(['rev-parse', 'main']);
  git(['checkout', '-q', '-b', 'other']);
  const res = await gitWorktree.integrateBranch({
    kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P, baseBranch: 'main', allowRefLanding: true,
  });
  expect(res).toEqual({ ok: true, integrated: false, reason: 'branch has no new commits' });
  expect(git(['rev-parse', 'main'])).toBe(before);
});

test('integrateOntoRef lands the clean case onto refs/heads/main while checkout is elsewhere', async () => {
  setup({ jobCommit: cleanJob });
  const p2 = git(['rev-parse', 'main']);
  git(['checkout', '-q', '-b', 'other']);
  const res = await gitWorktree.integrateOntoRef({ cwd: repo, targetRef: 'refs/heads/main', branch: 'sm-job/rw', forkSha: P });
  expect(res.ok).toBe(true);
  expect(res.linear).toBe(true);
  expect(res.replayedCommits).toBe(1);
  expect(git(['rev-parse', 'main'])).toBe(res.sha);
  expect(git(['rev-parse', 'main^'])).toBe(p2);
  expect(git(['log', '-1', '--format=%s', 'main'])).toBe('feat: job work');
  expect(git(['show', 'main:s.txt']).split('\n')[4]).toBe('U+P');
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('other');
});

test('ref-landing path: clean lands via integrateBranch, conflict parks without a merge', async () => {
  setup({ jobCommit: cleanJob });
  git(['checkout', '-q', '-b', 'other']);
  const res = await gitWorktree.integrateBranch({
    kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P, baseBranch: 'main', allowRefLanding: true,
  });
  expect(res.ok).toBe(true);
  expect(res.viaRef).toBe(true);
  expect(res.linear).toBe(true);
  expect(git(['log', '-1', '--format=%s', 'main'])).toBe('feat: job work');
});

test('ref-landing path: conflicting job parks as content_conflict, ref untouched', async () => {
  setup({ jobCommit: conflictJob });
  const before = git(['rev-parse', 'main']);
  git(['checkout', '-q', '-b', 'other']);
  const res = await gitWorktree.integrateBranch({
    kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P, baseBranch: 'main', allowRefLanding: true,
  });
  expect(res.ok).toBe(false);
  expect(res.failureKind).toBe('content_conflict');
  expect(res.conflictedPaths).toEqual(['s.txt']);
  expect(res.baseRewritten).toBe(true);
  expect(res.baseHeadSha).toBe(before);
  expect(res.reason).toContain('s.txt');
  expect(git(['rev-parse', 'main'])).toBe(before);
});
