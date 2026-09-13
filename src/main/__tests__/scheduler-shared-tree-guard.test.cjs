/**
 * scheduler-shared-tree-guard.test.cjs — the shared-tree stash guard added
 * for the 2026-09-01 social-signals-trader incident: a headless PRD executor
 * ran a blanket `git stash` in a working tree shared with a live trading
 * service, silently reverting an uncommitted operator config edit with no
 * error anywhere.
 *
 * evaluateSharedTreeGuard is the pure diff (no I/O); checkSharedTreeGuard is
 * the orchestrator that also restores a single unambiguous stash, using the
 * same module.exports spy pattern computeCommittedDuringRun/committedInWindow
 * use so the underlying git calls never actually run.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-shared-tree-guard.test.cjs
 */

'use strict';

import { test, expect, vi, afterEach } from 'vitest';
const fs = require('node:fs');
const scheduler = require('../scheduler.cjs');
const { evaluateSharedTreeGuard, checkSharedTreeGuard } = scheduler;

afterEach(() => {
  vi.restoreAllMocks();
});

test('evaluateSharedTreeGuard: no-op when nothing changed', () => {
  const result = evaluateSharedTreeGuard({
    stashBefore: ['aaa stash@{0} WIP on main: aaa old'],
    stashAfter: ['aaa stash@{0} WIP on main: aaa old'],
    dirtyBefore: ['data/spread_config.json'],
    dirtyAfter: ['data/spread_config.json'],
    pathsCommittedDuringRun: [],
  });
  expect(result.newStashes).toEqual([]);
  expect(result.reverted).toEqual([]);
});

test('evaluateSharedTreeGuard: flags one new stash entry not present in the baseline', () => {
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: ['bbb stash@{0} WIP on fix/x: bbb f5ae98f'],
    dirtyBefore: [],
    dirtyAfter: [],
    pathsCommittedDuringRun: [],
  });
  expect(result.newStashes).toEqual([{ hash: 'bbb', ref: 'stash@{0}', subject: 'WIP on fix/x: bbb f5ae98f' }]);
});

test('evaluateSharedTreeGuard: two new stash entries both surface (caller decides ambiguity, not this function)', () => {
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [
      'bbb stash@{0} WIP on fix/x: bbb newest',
      'ccc stash@{1} WIP on fix/x: ccc older',
    ],
    dirtyBefore: [],
    dirtyAfter: [],
    pathsCommittedDuringRun: [],
  });
  expect(result.newStashes).toHaveLength(2);
  expect(result.newStashes.map((e) => e.ref)).toEqual(['stash@{0}', 'stash@{1}']);
});

test('evaluateSharedTreeGuard: baseline-dirty path clean after the run with no commit to explain it is flagged reverted', () => {
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore: ['data/spread_config.json'],
    dirtyAfter: [],
    pathsCommittedDuringRun: [],
  });
  expect(result.reverted).toEqual(['data/spread_config.json']);
});

test('evaluateSharedTreeGuard: baseline-dirty path clean after the run but touched by a commit made during the run is NOT flagged', () => {
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore: ['src/foo.js'],
    dirtyAfter: [],
    pathsCommittedDuringRun: ['src/foo.js'],
  });
  expect(result.reverted).toEqual([]);
});

test('checkSharedTreeGuard: no-op when nothing changed returns null', async () => {
  vi.spyOn(scheduler, 'stashList').mockResolvedValue([]);
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue([]);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha1');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue([]);
  const restoreSpy = vi.spyOn(scheduler, 'restoreSpecificStash');

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: [],
    headBefore: 'sha1',
    slug: 'job-1',
  });
  expect(result).toBeNull();
  expect(restoreSpy).not.toHaveBeenCalled();
});

test('checkSharedTreeGuard: a single new stash is restored via apply+drop of that specific ref', async () => {
  vi.spyOn(scheduler, 'stashList').mockResolvedValue(['newhash stash@{0} WIP on main: f5ae98f']);
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue([]);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha1');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue([]);
  const restoreSpy = vi.spyOn(scheduler, 'restoreSpecificStash').mockResolvedValue({ ok: true });

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: [],
    headBefore: 'sha1',
    slug: 'job-1',
  });
  expect(restoreSpy).toHaveBeenCalledWith('/repo', 'stash@{0}');
  expect(result).toEqual({ restoredStash: 'stash@{0}' });
});

test('checkSharedTreeGuard: a baseline-dirty path stashed by the job and successfully restored is not ALSO flagged reverted', async () => {
  vi.spyOn(scheduler, 'stashList').mockResolvedValue(['newhash stash@{0} WIP on main: f5ae98f']);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha1');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue([]);
  vi.spyOn(scheduler, 'restoreSpecificStash').mockResolvedValue({ ok: true });
  // uncommittedChanges is queried AFTER the restore attempt in the fixed
  // implementation — simulate the stashed file reappearing dirty once the
  // apply+drop succeeds (this is the exact 2026-09-01 incident shape: an
  // operator's pre-existing dirty file gets swept into the job's stash).
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue(['data/spread_config.json']);

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: ['data/spread_config.json'],
    headBefore: 'sha1',
    slug: 'job-1',
  });
  expect(result).toEqual({ restoredStash: 'stash@{0}' });
});

test('checkSharedTreeGuard: two new stashes are reported, not restored (ambiguous)', async () => {
  vi.spyOn(scheduler, 'stashList').mockResolvedValue([
    'aaa stash@{0} WIP on main: newest',
    'bbb stash@{1} WIP on main: older',
  ]);
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue([]);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha1');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue([]);
  const restoreSpy = vi.spyOn(scheduler, 'restoreSpecificStash');

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: [],
    headBefore: 'sha1',
    slug: 'job-1',
  });
  expect(restoreSpy).not.toHaveBeenCalled();
  expect(result.ambiguousStashes).toEqual(['stash@{0}', 'stash@{1}']);
  expect(result.restoredStash).toBeUndefined();
});

test('checkSharedTreeGuard: a baseline-dirty path reverted with no stash and no commit is flagged reverted', async () => {
  vi.spyOn(scheduler, 'stashList').mockResolvedValue([]);
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue([]);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha1');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue([]);

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: ['data/spread_config.json'],
    headBefore: 'sha1',
    slug: 'job-1',
  });
  expect(result).toEqual({ reverted: ['data/spread_config.json'] });
});

test('checkSharedTreeGuard: a failed restore is reported as restoreFailed, entry left in place', async () => {
  vi.spyOn(scheduler, 'stashList').mockResolvedValue(['newhash stash@{0} WIP on main: f5ae98f']);
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue([]);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha1');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue([]);
  vi.spyOn(scheduler, 'restoreSpecificStash').mockResolvedValue({ ok: false, error: 'conflict applying stash' });

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: [],
    headBefore: 'sha1',
    slug: 'job-1',
  });
  expect(result.restoreFailed).toMatch(/stash@\{0\}.*conflict applying stash/);
});

test('checkSharedTreeGuard never throws when the underlying git calls reject', async () => {
  vi.spyOn(scheduler, 'stashList').mockRejectedValue(new Error('boom'));
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue([]);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha1');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue([]);

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: [],
    headBefore: 'sha1',
    slug: 'job-1',
  });
  expect(result).toBeNull();
});

// --- 2026-09-12 false-positive: an untracked path that merely became
// IGNORED during the run (a .gitignore edit) is not a revert. See the
// evaluateSharedTreeGuard doc comment for the full incident writeup. Each
// test below is written to FAIL against the pre-fix implementation (which
// computed `reverted = dirtyBefore - dirtyAfter - committed` with no
// existence/tracked-status distinction at all) and PASS after it.

test('evaluateSharedTreeGuard: an untracked path that disappears from git status but STILL EXISTS on disk is nowIgnored, not reverted', () => {
  // Pre-fix behavior: this path would land in `reverted` (dirtyBefore minus
  // dirtyAfter minus committed, no existence check at all) — FAILS pre-fix.
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore: [{ code: '??', path: 'session-manager-operations/logs/errors-2026-09-12.jsonl' }],
    dirtyAfter: [],
    pathsCommittedDuringRun: ['.gitignore'],
    existsAfter: ['session-manager-operations/logs/errors-2026-09-12.jsonl'],
  });
  expect(result.reverted).toEqual([]);
  expect(result.nowIgnored).toEqual(['session-manager-operations/logs/errors-2026-09-12.jsonl']);
});

test('evaluateSharedTreeGuard: an untracked path that disappears from git status AND no longer exists on disk is still reverted', () => {
  // Proves the fix is not a blanket "stop reporting reverted": a genuinely
  // deleted untracked file (the guard's real purpose — catching a job that
  // discarded uncommitted work) must still surface. If the fix had simply
  // stopped reporting any untracked-and-missing path as reverted, this test
  // would fail (reverted would come back empty instead of containing the
  // path).
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore: [{ code: '??', path: 'data/scratch.txt' }],
    dirtyAfter: [],
    pathsCommittedDuringRun: [],
    existsAfter: [], // file no longer exists on disk
  });
  expect(result.reverted).toEqual(['data/scratch.txt']);
  expect(result.nowIgnored).toEqual([]);
});

test('evaluateSharedTreeGuard: a TRACKED path clean after the run is still reverted even though it exists on disk', () => {
  // A tracked file leaving the dirty set means its content was restored to
  // HEAD — exactly the discard this guard exists to catch — regardless of
  // whether the file is still present. Pre-fix this already worked by
  // accident (no existence check existed at all); this test pins the
  // behavior now that existence checks exist for the untracked branch, so a
  // future change can't accidentally start trusting `existsAfter` for
  // tracked paths too.
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore: [{ code: ' M', path: 'src/config.js' }],
    dirtyAfter: [],
    pathsCommittedDuringRun: [],
    existsAfter: ['src/config.js'], // file exists, but content was reset to HEAD
  });
  expect(result.reverted).toEqual(['src/config.js']);
  expect(result.nowIgnored).toEqual([]);
});

test('checkSharedTreeGuard end-to-end: the real 2026-09-12 incident shape — untracked logs path ignored by a committed .gitignore change, file still on disk — must NOT verdict shared_tree_reverted', async () => {
  // PRD 1181's exact shape: a bare `logs/` pattern lands in .gitignore during
  // the run (committed), eleven untracked log paths vanish from `git status`,
  // and the files are untouched on disk. Pre-fix, checkSharedTreeGuard's
  // `reverted` would contain this path (no existsAfter computation existed),
  // driving the caller's `verdict: 'shared_tree_reverted'` downgrade — FAILS
  // pre-fix.
  const logPath = 'session-manager-operations/logs/errors-2026-09-12.jsonl';
  vi.spyOn(scheduler, 'stashList').mockResolvedValue([]);
  vi.spyOn(scheduler, 'gitHead').mockResolvedValue('sha-after');
  vi.spyOn(scheduler, 'pathsChangedSince').mockResolvedValue(['.gitignore']);
  vi.spyOn(scheduler, 'uncommittedChanges').mockResolvedValue([]); // the log path no longer shows up at all
  vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).includes('errors-2026-09-12.jsonl'));

  const result = await checkSharedTreeGuard({
    cwd: '/repo',
    stashBaseline: [],
    dirtyBaseline: [{ code: '??', path: logPath }],
    headBefore: 'sha-before',
    slug: 'job-1181',
  });

  expect(result.reverted).toBeUndefined();
  expect(result.nowIgnored).toEqual([logPath]);
});
