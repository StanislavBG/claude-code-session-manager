/**
 * health-build-freshness.test.cjs — evaluateBuildFreshness separates
 * restart-needed (installed differs from running) from publish-needed
 * (repo HEAD differs from installed); both reported, never critical.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-build-freshness.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { evaluateBuildFreshness } = require('../health.cjs');

test('all shas equal → nothing needed', () => {
  const r = evaluateBuildFreshness({ running: 'abc1234', installedOnDisk: 'abc1234', repoHead: 'abc1234' });
  expect(r).toMatchObject({ ok: true, restartNeeded: false, publishNeeded: false });
});

test('installed differs from running → restart needed only', () => {
  const r = evaluateBuildFreshness({ running: 'aaa1111', installedOnDisk: 'bbb2222', repoHead: 'bbb2222' });
  expect(r).toMatchObject({ ok: true, restartNeeded: true, publishNeeded: false });
});

test('repo HEAD differs from installed → publish needed only', () => {
  const r = evaluateBuildFreshness({ running: 'bbb2222', installedOnDisk: 'bbb2222', repoHead: 'ccc3333' });
  expect(r).toMatchObject({ ok: true, restartNeeded: false, publishNeeded: true });
});

test('both differ → both reported, still ok (non-critical)', () => {
  const r = evaluateBuildFreshness({ running: 'aaa1111', installedOnDisk: 'bbb2222', repoHead: 'ccc3333' });
  expect(r).toMatchObject({ ok: true, restartNeeded: true, publishNeeded: true });
  expect(r.note).toMatch(/restart needed/);
  expect(r.note).toMatch(/publish needed/);
});

test('unknown inputs never claim a difference; short/long sha prefixes match', () => {
  expect(evaluateBuildFreshness({})).toMatchObject({ restartNeeded: false, publishNeeded: false });
  expect(evaluateBuildFreshness({ running: null, installedOnDisk: 'abc1234', repoHead: 'abc1234567890' }))
    .toMatchObject({ restartNeeded: false, publishNeeded: false });
});

const { WORKTREE_SAFETY_PATHS } = require('../health.cjs');

test('WORKTREE_SAFETY_PATHS lists the four worktree-safety files', () => {
  expect(WORKTREE_SAFETY_PATHS).toEqual([
    'src/main/lib/git/worktreeDeps.cjs',
    'src/main/lib/git/depHealth.cjs',
    'src/main/lib/git/gitWorktree.cjs',
    'src/main/lib/git/jobWorktree.cjs',
  ]);
});

test('empty/omitted safetyCommitsMissing → no safetyIssue', () => {
  const a = evaluateBuildFreshness({ running: 'cf5b9a82', installedOnDisk: 'cf5b9a82', repoHead: 'ddd4444' });
  expect(a.safetyIssue).toBeUndefined();
  expect(a.safetyCommitsMissing).toEqual([]);
  const b = evaluateBuildFreshness({ running: 'cf5b9a82', safetyCommitsMissing: [] });
  expect(b.safetyIssue).toBeUndefined();
});

test('two missing safety commits → safetyIssue names running sha, count, shas; ok stays true', () => {
  const r = evaluateBuildFreshness({
    running: 'cf5b9a82',
    repoHead: 'ddd4444',
    safetyCommitsMissing: [
      { sha: '1113551', subject: 'fix(worktree): no pnpm symlink' },
      { sha: '2224662', subject: 'fix(depHealth): guard' },
    ],
  });
  expect(r.ok).toBe(true);
  expect(r.safetyIssue).toContain('cf5b9a82');
  expect(r.safetyIssue).toContain('2');
  expect(r.safetyIssue).toContain('1113551');
  expect(r.safetyIssue).toContain('2224662');
  expect(r.safetyIssue).toContain('publish a new release and restart Session Manager');
});

test('five missing safety commits → only three listed', () => {
  const commits = Array.from({ length: 5 }, (_, i) => ({ sha: `sha000${i}`, subject: `subj${i}` }));
  const r = evaluateBuildFreshness({ running: 'cf5b9a82', safetyCommitsMissing: commits });
  expect(r.safetyIssue).toContain('5');
  for (const i of [0, 1, 2]) expect(r.safetyIssue).toContain(`sha000${i}`);
  for (const i of [3, 4]) expect(r.safetyIssue).not.toContain(`sha000${i}`);
});
