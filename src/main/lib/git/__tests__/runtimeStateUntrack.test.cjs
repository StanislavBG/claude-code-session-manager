/**
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/runtimeStateUntrack.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findTrackedRuntimeState, untrackRuntimeState, listRuntimeFilesOnDisk } = require('../runtimeStateUntrack.cjs');

let root;
const OPS = 'session-manager-operations';
const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const write = (rel, c = 'x') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), c);
};
const idle = { isProjectBusy: () => false };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rsu-')));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  write('a.txt');
  write(`${OPS}/scheduler/queue.json`, '{}');
  write(`${OPS}/scheduler/README.md`, '# keep');
  write(`${OPS}/scheduler/epics/e1/prds/1.md`, 'prd');
  write(`${OPS}/prompt-sessions/s.json`, '{}');
  write(`${OPS}/reviews/r.md`, 'review');
  g('add', '-A');
  g('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const headSha = () => g('rev-parse', 'HEAD');

async function expectRefusal(opts, match) {
  const sha = headSha();
  const r = await untrackRuntimeState(root, opts);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(match);
  expect(headSha()).toBe(sha);
  expect(g('ls-files', `${OPS}/scheduler`).split('\n').length).toBeGreaterThan(1);
}

test('findTrackedRuntimeState excludes README.md and authored namespaces', async () => {
  const found = await findTrackedRuntimeState(root);
  expect(found.sort()).toEqual([
    `${OPS}/prompt-sessions/s.json`,
    `${OPS}/scheduler/epics/e1/prds/1.md`,
    `${OPS}/scheduler/queue.json`,
  ]);
});

test('refuses in a linked worktree', async () => {
  const wt = path.join(os.tmpdir(), `rsu-wt-${Date.now()}`);
  g('worktree', 'add', '-q', '-b', 'side', wt);
  try {
    const r = await untrackRuntimeState(fs.realpathSync(wt), idle);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/linked worktree/);
  } finally {
    g('worktree', 'remove', '--force', wt);
  }
});

test('refuses when HEAD is not the default branch', async () => {
  g('checkout', '-q', '-b', 'feature');
  await expectRefusal(idle, /not the default branch/);
});

test('refuses during a merge in progress', async () => {
  fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), headSha() + '\n');
  await expectRefusal(idle, /in progress/);
});

test('refuses during a rebase in progress', async () => {
  fs.mkdirSync(path.join(root, '.git', 'rebase-merge'));
  await expectRefusal(idle, /in progress/);
});

test('refuses during a cherry-pick in progress', async () => {
  fs.writeFileSync(path.join(root, '.git', 'CHERRY_PICK_HEAD'), headSha() + '\n');
  await expectRefusal(idle, /in progress/);
});

test('refuses when the index has staged changes', async () => {
  write('b.txt');
  g('add', 'b.txt');
  await expectRefusal(idle, /staged/);
});

test('refuses when a job is running', async () => {
  await expectRefusal({ isProjectBusy: async () => true }, /job is running/);
});

test('success: files stay on disk, runtime paths untracked, reviews tracked', async () => {
  const before = listRuntimeFilesOnDisk(root);
  const r = await untrackRuntimeState(root, idle);
  expect(r).toMatchObject({ ok: true, removed: 3, committed: true });
  expect(listRuntimeFilesOnDisk(root)).toEqual(before);
  expect(fs.existsSync(path.join(root, OPS, 'scheduler/queue.json'))).toBe(true);
  expect(await findTrackedRuntimeState(root)).toEqual([]);
  const tracked = g('ls-files').split('\n');
  expect(tracked).toContain(`${OPS}/reviews/r.md`);
  expect(tracked).toContain(`${OPS}/scheduler/README.md`);
  expect(tracked).toContain('a.txt');
  expect(g('log', '-1', '--format=%B')).toMatch(/Co-Authored-By: Claude/);
  expect(g('show', '--name-status', '--format=', 'HEAD').split('\n').every((l) => l.startsWith('D\t'))).toBe(true);
  expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
});

test('nothing tracked is a no-op success', async () => {
  await untrackRuntimeState(root, idle);
  const sha = headSha();
  const r = await untrackRuntimeState(root, idle);
  expect(r).toMatchObject({ ok: true, removed: 0, committed: false });
  expect(headSha()).toBe(sha);
});
