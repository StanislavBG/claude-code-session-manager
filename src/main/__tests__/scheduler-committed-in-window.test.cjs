/**
 * scheduler-committed-in-window.test.cjs — unit tests for committedInWindow
 * and computeCommittedDuringRun's bounded retry.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-committed-in-window.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const scheduler = require('../scheduler.cjs');
const { committedInWindow, computeCommittedDuringRun } = scheduler;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-committed-in-window-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

test('committedInWindow returns true for a commit landed on a non-checked-out branch', async () => {
  const dir = makeRepo();
  try {
    git(dir, ['checkout', '-q', '-b', 'work']);

    const startedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'feature commit']);
    const finishedAt = new Date(Date.now() + 1000).toISOString();

    // Simulate the run leaving a different branch checked out at exit.
    git(dir, ['checkout', '-q', '-b', 'other-branch-at-exit']);

    const result = await committedInWindow(dir, startedAt, finishedAt);
    expect(result).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('committedInWindow returns false when the window covers no commit', async () => {
  const dir = makeRepo();
  try {
    const farFutureStart = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const farFutureEnd = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString();

    const result = await committedInWindow(dir, farFutureStart, farFutureEnd);
    expect(result).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Reproduces the sigma PRD 713 incident: a commit made+pushed from an
// isolated worktree checkout that shares the run's remote but not job.cwd's
// local refs — e.g. `git worktree add /tmp/foo` followed by `git worktree
// remove` clears the worktree's local branch, leaving the commit reachable
// in job.cwd only via a remote-tracking ref that hasn't been fetched yet.
// Modeled here as a second, independent clone of the shared remote (rather
// than a literal `git worktree add`, which shares job.cwd's .git store and
// so opportunistically updates job.cwd's remote-tracking ref on push,
// masking the staleness this test needs to exercise) — the observable
// symptom is identical: job.cwd's remote-tracking ref is stale until fetched.
test('committedInWindow sees a commit pushed from an isolated checkout, only reachable via a stale remote-tracking ref', async () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-committed-in-window-bare-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-committed-in-window-cwd-'));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-committed-in-window-wt-'));
  try {
    git(bareDir, ['init', '-q', '--bare']);

    const seedDir = makeRepo();
    try {
      git(seedDir, ['push', bareDir, 'HEAD:refs/heads/main']);
      // Without an explicit default branch, the bare repo's symbolic HEAD can
      // point at a nonexistent ref (e.g. 'master'), which makes the clone
      // below check out no local branch at all — set it explicitly.
      git(bareDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    } finally {
      fs.rmSync(seedDir, { recursive: true, force: true });
    }

    git(cwd, ['clone', '-q', bareDir, '.']);
    git(cwd, ['config', 'user.email', 'test@example.com']);
    git(cwd, ['config', 'user.name', 'Test']);

    const startedAt = new Date().toISOString();

    // Simulate the PRD's own isolated-checkout workflow: a separate clone of
    // the same shared remote, a commit there, a push back to that remote —
    // job.cwd never touches this checkout and never fetches after the push.
    git(worktreeDir, ['clone', '-q', bareDir, '.']);
    git(worktreeDir, ['config', 'user.email', 'test@example.com']);
    git(worktreeDir, ['config', 'user.name', 'Test']);
    git(worktreeDir, ['checkout', '-q', '-b', 'temp-merge-branch']);
    fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), 'feature\n');
    git(worktreeDir, ['add', '.']);
    git(worktreeDir, ['commit', '-q', '-m', 'feature commit from isolated worktree']);
    git(worktreeDir, ['push', 'origin', 'temp-merge-branch']);

    const finishedAt = new Date(Date.now() + 1000).toISOString();

    // Precondition: without a fetch, job.cwd genuinely cannot see the commit —
    // this is what made committedInWindow's old bare `git log --all` blind to it.
    expect(() => git(cwd, ['log', '--all', '--format=%H', '--grep=feature commit from isolated worktree']))
      .not.toThrow();
    const beforeFetch = git(cwd, ['log', '--all', '--format=%H', '--grep=feature commit from isolated worktree']);
    expect(beforeFetch).toBe('');

    const result = await committedInWindow(cwd, startedAt, finishedAt);
    expect(result).toBe(true);
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

// Reproduces the pass-no-commit-worktree / RCA 770-pr269 incidents: the live
// commit-guard's committedInWindow() call can race against ref/object
// visibility at the exact moment of process exit and return false even
// though the commit is real. computeCommittedDuringRun() should retry once
// after a bounded delay before giving up.
test('computeCommittedDuringRun retries committedInWindow once and returns true when the retry succeeds', async () => {
  vi.useFakeTimers();
  try {
    const spy = vi.spyOn(scheduler, 'committedInWindow')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const resultPromise = computeCommittedDuringRun('/tmp/fake', 'abc', 'abc', 'start', 'until');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

test('computeCommittedDuringRun returns false when both committedInWindow calls return false', async () => {
  vi.useFakeTimers();
  try {
    const spy = vi.spyOn(scheduler, 'committedInWindow').mockResolvedValue(false);

    const resultPromise = computeCommittedDuringRun('/tmp/fake', 'abc', 'abc', 'start', 'until');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

test('computeCommittedDuringRun skips the retry (and the delay) when the HEAD-diff fast path already resolves true', async () => {
  const spy = vi.spyOn(scheduler, 'committedInWindow');
  try {
    const result = await computeCommittedDuringRun('/tmp/fake', 'headBefore', 'headAfter', 'start', 'until');

    expect(result).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
