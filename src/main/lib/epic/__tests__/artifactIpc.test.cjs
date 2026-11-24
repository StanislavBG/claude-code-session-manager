/**
 * artifactIpc.test.cjs — artifacts:list (store entries + Epic titles) and
 * artifacts:worktrees (active Epics' on-disk, git-registered worktrees with
 * aheadOfBase) against a temp git repo and a fake active index.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/artifactIpc.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { registerArtifactHandlers, GIT_TIMEOUT_MS } = require('../artifactIpc.cjs');
const { execGit } = require('../../git/gitExec.cjs');

let tmp;
let repo;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifact-ipc-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'base');
  // Epic A: two commits ahead of main.
  git(repo, 'worktree', 'add', '-q', '-b', 'sm-epic/epic-a', path.join(tmp, 'wt-a'));
  for (const n of ['1', '2']) {
    fs.writeFileSync(path.join(tmp, 'wt-a', `f${n}.txt`), n);
    git(path.join(tmp, 'wt-a'), 'add', `f${n}.txt`);
    git(path.join(tmp, 'wt-a'), 'commit', '-q', '-m', `c${n}`);
  }
  // Epic C: completed — has a worktree, but must not be listed.
  git(repo, 'worktree', 'add', '-q', '-b', 'sm-epic/epic-c', path.join(tmp, 'wt-c'));
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SESSIONS = () => ({
  'epic-a': { id: 'epic-a', status: 'active', goalText: 'Title A\n\nGoal A', worktree: { dir: path.join(tmp, 'wt-a'), branch: 'sm-epic/epic-a', baseCwd: repo, status: 'active' } },
  // Recorded worktree no longer on disk.
  'epic-b': { id: 'epic-b', status: 'active', goalText: 'Title B', worktree: { dir: path.join(tmp, 'wt-gone'), branch: 'sm-epic/epic-b', baseCwd: repo, status: 'active' } },
  'epic-c': { id: 'epic-c', status: 'completed', goalText: 'Title C', worktree: { dir: path.join(tmp, 'wt-c'), branch: 'sm-epic/epic-c', baseCwd: repo, status: 'active' } },
  // On disk but not a git worktree of this repo.
  'epic-d': { id: 'epic-d', status: 'active', goalText: 'Title D', worktree: { dir: tmp, branch: 'sm-epic/epic-d', baseCwd: repo, status: 'active' } },
  // Not isolated.
  'epic-e': { id: 'epic-e', status: 'active', goalText: 'Title E' },
});

function setup(over = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (c, h) => handlers.set(c, h) };
  const deps = {
    ipcMain,
    validatePath: vi.fn((p) => p),
    readActiveIndex: vi.fn(() => ({ sessions: SESSIONS() })),
    readMirror: vi.fn((_cwd, id) => (id === 'epic-old' ? { goalText: 'Old title\n\nbody' } : null)),
    listArtifacts: vi.fn(() => [
      { name: 'demo.mp4', ownerId: 'epic-a', createdAt: '2026-11-23T02:00:00Z' },
      { name: 'old.png', ownerId: 'epic-old', createdAt: '2026-11-22T02:00:00Z' },
      { name: 'task.txt', ownerId: '_tasks/task-1', createdAt: '2026-11-21T02:00:00Z' },
    ]),
    execGit: vi.fn(execGit),
    ...over,
  };
  registerArtifactHandlers(deps);
  return { call: async (ch, p) => handlers.get(ch)({}, p), deps, handlers };
}

test('registers exactly the two read channels', () => {
  const { handlers } = setup();
  expect([...handlers.keys()].sort()).toEqual(['artifacts:list', 'artifacts:worktrees']);
});

test('artifacts:list joins each entry with its Epic title (index, then mirror; Tasks get null)', async () => {
  const { call, deps } = setup();
  const res = await call('artifacts:list', { cwd: repo });
  expect(deps.validatePath).toHaveBeenCalledWith(repo);
  expect(deps.listArtifacts).toHaveBeenCalledWith(repo);
  expect(res.ok).toBe(true);
  expect(res.artifacts.map((a) => [a.name, a.epicTitle])).toEqual([
    ['demo.mp4', 'Title A'], ['old.png', 'Old title'], ['task.txt', null],
  ]);
  expect(deps.readMirror).toHaveBeenCalledTimes(1);
});

test('artifacts:list against the real store on an empty project returns []', async () => {
  const { call } = setup({ listArtifacts: undefined });
  fs.mkdirSync(path.join(repo, 'session-manager-operations'), { recursive: true });
  expect(await call('artifacts:list', { cwd: repo })).toEqual({ ok: true, artifacts: [] });
});

test('artifacts:worktrees lists only on-disk, registered worktrees of active Epics, with aheadOfBase', async () => {
  const { call, deps } = setup();
  const res = await call('artifacts:worktrees', { cwd: repo });
  expect(res).toEqual({
    ok: true,
    worktrees: [{ epicId: 'epic-a', title: 'Title A', path: path.join(tmp, 'wt-a'), branch: 'sm-epic/epic-a', aheadOfBase: 2 }],
  });
  const revList = deps.execGit.mock.calls.filter((c) => c[1][0] === 'rev-list');
  expect(revList).toHaveLength(1);
  expect(revList[0][1]).toEqual(['rev-list', '--count', 'HEAD..sm-epic/epic-a', '--']);
  for (const c of deps.execGit.mock.calls) expect(c[2].timeout).toBe(GIT_TIMEOUT_MS);
  for (const c of deps.execGit.mock.calls) expect(String(c[0])).not.toContain(path.join('.claude', 'projects'));
});

test('artifacts:worktrees reports aheadOfBase null when rev-list fails, [] outside a repo', async () => {
  const failing = vi.fn((cwd, args, opts) => (args[0] === 'rev-list' ? Promise.reject(new Error('boom')) : execGit(cwd, args, opts)));
  const r1 = await setup({ execGit: failing }).call('artifacts:worktrees', { cwd: repo });
  expect(r1.worktrees).toHaveLength(1);
  expect(r1.worktrees[0].aheadOfBase).toBeNull();
  const notRepo = fs.mkdtempSync(path.join(tmp, 'plain-'));
  const r2 = await setup().call('artifacts:worktrees', { cwd: notRepo });
  expect(r2).toEqual({ ok: true, worktrees: [] });
});

test('payloads are strict: missing/empty cwd or extra keys are rejected', async () => {
  const { call, deps } = setup();
  for (const ch of ['artifacts:list', 'artifacts:worktrees']) {
    for (const bad of [undefined, {}, { cwd: '' }, { cwd: 5 }, { cwd: repo, path: '/etc' }]) {
      await expect(call(ch, bad)).rejects.toThrow();
    }
  }
  expect(deps.listArtifacts).not.toHaveBeenCalled();
});

test('validatePath refusal rejects before any read', async () => {
  const { call, deps } = setup({ validatePath: () => { throw new Error('Path outside allowed boundaries'); } });
  await expect(call('artifacts:list', { cwd: '/etc' })).rejects.toThrow(/outside/);
  await expect(call('artifacts:worktrees', { cwd: '/etc' })).rejects.toThrow(/outside/);
  expect(deps.readActiveIndex).not.toHaveBeenCalled();
});
