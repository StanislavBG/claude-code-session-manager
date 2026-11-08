/**
 * integrateRewrittenBaseCarriedWip.test.cjs — on a rewritten base (main
 * rebased/reset while the job ran), the carried-WIP shortcut is bounded at
 * the job's fork so a branch that only committed the human's carried WIP is
 * NOT replayed onto main; and a non-conflict replay failure (here
 * branch_has_merges) names the job's own paths.
 *
 * Real throwaway repos under `os.tmpdir()`.
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/integrateRewrittenBaseCarriedWip.test.cjs
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
function setup({ jobCommit, beforeRewrite }) {
  commitFile('s.txt', lines('l5'), 'B');
  const B = git(['rev-parse', 'HEAD']);
  commitFile('s.txt', lines('P'), 'P');
  P = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', '-b', 'sm-job/rw']);
  if (jobCommit) jobCommit();
  git(['checkout', '-q', 'main']);
  if (beforeRewrite) beforeRewrite();
  git(['reset', '-q', '--hard', B]);
  commitFile('s.txt', lines('U'), 'U');
  commitFile('s.txt', lines('U+P'), 'P2');
}

/**
 * Job branch with an "evil" merge: the merge commit itself adds e.txt, content
 * no replayed (non-merge) commit carries, so the linear replay fails
 * branch_has_merges.
 */
function mergeJob() {
  git(['checkout', '-q', '-b', 'side']);
  commitFile('side.txt', 'side\n', 'feat: side work');
  git(['checkout', '-q', 'sm-job/rw']);
  commitFile('j.txt', 'job\n', 'feat: job work');
  git(['merge', '-q', '--no-ff', '--no-commit', 'side']);
  fs.writeFileSync(path.join(repo, 'e.txt'), 'evil\n', 'utf8');
  git(['add', 'e.txt']);
  git(['commit', '-q', '--no-edit']);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-rewritten-base-wip-'));
  repo = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('branch whose only commit is the carried WIP is not replayed onto the rewritten base', async () => {
  const WIP = 'human wip\n';
  setup({
    jobCommit: () => commitFile('w.txt', WIP, 'chore: carried wip'),
    // Untracked in the main checkout — reset --hard keeps untracked files.
    beforeRewrite: () => fs.writeFileSync(path.join(repo, 'w.txt'), WIP, 'utf8'),
  });
  const before = git(['rev-parse', 'HEAD']);
  const res = await gitWorktree.integrateBranch({
    kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P, carriedPaths: ['w.txt'],
  });
  expect(res).toEqual({ ok: true, integrated: false, reason: 'carried-wip-only' });
  expect(git(['rev-parse', 'HEAD'])).toBe(before);
  expect(fs.readFileSync(path.join(repo, 'w.txt'), 'utf8')).toBe(WIP);
  expect(git(['status', '--porcelain'])).toBe('?? w.txt');
});

test('isCarriedWipOnly honours scopeBase', async () => {
  const WIP = 'human wip\n';
  setup({
    jobCommit: () => commitFile('w.txt', WIP, 'chore: carried wip'),
    beforeRewrite: () => fs.writeFileSync(path.join(repo, 'w.txt'), WIP, 'utf8'),
  });
  const args = { cwd: repo, branch: 'sm-job/rw', carriedPaths: ['w.txt'] };
  expect(await gitWorktree.isCarriedWipOnly(args)).toBe(false);
  expect(await gitWorktree.isCarriedWipOnly({ ...args, scopeBase: P })).toBe(true);
});

test('branch_has_merges on a rewritten base lists the job\'s own paths', async () => {
  setup({ jobCommit: mergeJob });
  const before = git(['rev-parse', 'HEAD']);
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/rw', key: 'rw', forkSha: P });
  expect(res.ok).toBe(false);
  expect(res.baseRewritten).toBe(true);
  expect(res.conflictedPaths).toEqual(['e.txt', 'j.txt', 'side.txt']);
  expect(res.reason).toContain('branch_has_merges');
  expect(res.reason).toContain('j.txt');
  expect(res.reason).toContain('side.txt');
  expect(git(['rev-parse', 'HEAD'])).toBe(before);
  expect(git(['rev-list', '--merges', 'HEAD'])).toBe('');
});

test('integrateOntoRef: branch_has_merges on a rewritten base lists the job\'s own paths', async () => {
  setup({ jobCommit: mergeJob });
  const before = git(['rev-parse', 'main']);
  git(['checkout', '-q', '-b', 'other']);
  const res = await gitWorktree.integrateOntoRef({ cwd: repo, targetRef: 'refs/heads/main', branch: 'sm-job/rw', forkSha: P });
  expect(res.ok).toBe(false);
  expect(res.baseRewritten).toBe(true);
  expect(res.conflictedPaths).toEqual(['e.txt', 'j.txt', 'side.txt']);
  expect(res.reason).toContain('j.txt');
  expect(git(['rev-parse', 'main'])).toBe(before);
});
