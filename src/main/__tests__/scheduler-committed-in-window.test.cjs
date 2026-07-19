/**
 * scheduler-committed-in-window.test.cjs — unit tests for committedInWindow.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-committed-in-window.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { committedInWindow } = require('../scheduler.cjs');

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
