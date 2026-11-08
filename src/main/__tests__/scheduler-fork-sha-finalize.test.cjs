/**
 * scheduler-fork-sha-finalize.test.cjs — a job whose base branch was rebased
 * while it ran lands its OWN commits on the new tip (finalizeJobWorktree threads
 * worktree.forkSha into integrateJobBranch) instead of parking
 * worktree_integration_failed; a genuine conflict still fails and names the path.
 *
 * HOME is set to a tmp dir BEFORE requiring scheduler.cjs (queue I/O is rooted
 * at os.homedir() at require time).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-fork-sha-finalize.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { git } = require('./_helpers/schedulerHarness.cjs');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fork-sha-finalize-test-'));
process.env.HOME = tmpHome;

const { finalizeJobWorktree, worktreeIntegrationVerdict, stampIntegrationFailure } = require('../scheduler.cjs');
const { selectMechanicalRecoveryTarget } = require('../scheduler/reviewLadder.cjs');
const jobWorktree = require('../lib/git/jobWorktree.cjs');

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function lines(l5) {
  return Array.from({ length: 10 }, (_, i) => (i === 4 ? l5 : `l${i + 1}`)).join('\n') + '\n';
}

function commitFile(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  git(['add', '--', file], dir);
  git(['commit', '-q', '-m', msg], dir);
  return git(['rev-parse', 'HEAD'], dir).trim();
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fork-sha-repo-'));
  tmpDirs.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'init.defaultBranch', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  return dir;
}

/** B, P, worktree, J (in worktree), then main rewritten: reset B, U, P2. */
async function setup(slug, { conflict }) {
  const cwd = initRepo();
  const B = commitFile(cwd, 's.txt', lines('l5'), 'B');
  commitFile(cwd, 's.txt', lines('P'), 'P');
  const worktree = await jobWorktree.createJobWorktree({ cwd, slug });
  expect(worktree.ok).toBe(true);
  tmpDirs.push(worktree.dir);
  expect(typeof worktree.forkSha).toBe('string');
  if (conflict) commitFile(worktree.dir, 's.txt', lines('J'), 'feat: job work');
  else commitFile(worktree.dir, 'j.txt', 'job\n', 'feat: job work');
  git(['reset', '-q', '--hard', B], cwd);
  commitFile(cwd, 's.txt', lines('U'), 'U');
  commitFile(cwd, 's.txt', lines('U+P'), 'P2');
  return { cwd, worktree };
}

async function finalize(slug, cwd, worktree) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fork-sha-run-'));
  tmpDirs.push(runDir);
  return finalizeJobWorktree({
    job: { slug, cwd }, runId: 'r1', runDir, worktree, guardCwd: cwd, carriedPaths: [],
    deps: { isRunCancelled: async () => false },
  });
}

test('rewritten base: job commit J lands on the new tip', async () => {
  const slug = 'fork-sha-ok';
  const { cwd, worktree } = await setup(slug, { conflict: false });
  const res = await finalize(slug, cwd, worktree);
  expect(res.worktreeIntegrationFailure).toBe(null);
  expect(typeof res.integratedSha).toBe('string');
  expect(git(['log', '-1', '--format=%s', res.integratedSha], cwd).trim()).toBe('feat: job work');
  expect(fs.readFileSync(path.join(cwd, 's.txt'), 'utf8')).toBe(lines('U+P'));
}, 60_000);

test('rewritten base: a conflicting J fails and the verdict names s.txt', async () => {
  const slug = 'fork-sha-conflict';
  const { cwd, worktree } = await setup(slug, { conflict: true });
  const res = await finalize(slug, cwd, worktree);
  expect(res.worktreeIntegrationFailure).toBeTruthy();
  const verdict = worktreeIntegrationVerdict({ failure: res.worktreeIntegrationFailure, detail: res.worktreeIntegrationDetail, slug });
  expect(verdict.verdict).toBe('worktree_integration_failed');
  expect(verdict.reason).toContain('s.txt');
}, 60_000);

test('selectMechanicalRecoveryTarget carries worktreeForkSha as forkSha', () => {
  const base = { slug: 'x', status: 'needs_review', verifierVerdict: 'worktree_integration_failed', cwd: '/tmp/x' };
  expect(selectMechanicalRecoveryTarget({ ...base, worktreeForkSha: 'abc123' }).forkSha).toBe('abc123');
  expect(selectMechanicalRecoveryTarget(base).forkSha).toBe(null);
});

test('stampIntegrationFailure records integrationBaseRewritten', () => {
  const row = {};
  stampIntegrationFailure(row, { ok: false, failureKind: 'ref_race', baseRewritten: true });
  expect(row.integrationBaseRewritten).toBe(true);
  stampIntegrationFailure(row, { ok: false, failureKind: 'other' });
  expect('integrationBaseRewritten' in row).toBe(false);
  row.integrationBaseRewritten = true;
  stampIntegrationFailure(row, null);
  expect('integrationBaseRewritten' in row).toBe(false);
});
