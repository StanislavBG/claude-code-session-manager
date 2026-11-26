/**
 * epicDepsSync.test.cjs — syncEpicWorktreeDeps: no-op cases, 30 s throttle,
 * a throwing/rejecting sync never escapes, and the call never blocks the caller.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epicDepsSync.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';

const worktreeDeps = require('../lib/git/worktreeDeps.cjs');
const ds = require('../lib/epic/epicDepsSync.cjs');

const tick = () => new Promise((r) => setImmediate(r));
let prevEnv;

beforeEach(() => {
  ds.__resetForTests();
  prevEnv = process.env.SM_WORKTREE_DEP_LINK_DISABLE;
  delete process.env.SM_WORKTREE_DEP_LINK_DISABLE;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevEnv === undefined) delete process.env.SM_WORKTREE_DEP_LINK_DISABLE;
  else process.env.SM_WORKTREE_DEP_LINK_DISABLE = prevEnv;
});

test('no-op when worktreeCwd equals projectCwd', async () => {
  const spy = vi.spyOn(worktreeDeps, 'syncNodeModulesLinks').mockResolvedValue({ added: 0, removed: 0 });
  expect(ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/p' })).toBe(false);
  await tick();
  expect(spy).not.toHaveBeenCalled();
});

test('no-op when SM_WORKTREE_DEP_LINK_DISABLE=1', async () => {
  process.env.SM_WORKTREE_DEP_LINK_DISABLE = '1';
  const spy = vi.spyOn(worktreeDeps, 'syncNodeModulesLinks').mockResolvedValue({ added: 0, removed: 0 });
  expect(ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w' })).toBe(false);
  await tick();
  expect(spy).not.toHaveBeenCalled();
});

test('no-op on missing cwds', async () => {
  const spy = vi.spyOn(worktreeDeps, 'syncNodeModulesLinks').mockResolvedValue({ added: 0, removed: 0 });
  expect(ds.syncEpicWorktreeDeps({ projectCwd: '', worktreeCwd: '/w' })).toBe(false);
  expect(ds.syncEpicWorktreeDeps(/** @type {any} */ (undefined))).toBe(false);
  await tick();
  expect(spy).not.toHaveBeenCalled();
});

test('calls syncNodeModulesLinks with mainCwd/worktreeCwd, non-blocking', async () => {
  const spy = vi.spyOn(worktreeDeps, 'syncNodeModulesLinks').mockReturnValue(new Promise(() => {}));
  const ret = ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w' });
  // Returned synchronously, before the sync even started.
  expect(ret).toBe(true);
  expect(spy).not.toHaveBeenCalled();
  await tick();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith({ mainCwd: '/p', worktreeCwd: '/w' });
});

test('throttles to once per worktree per 30 seconds', async () => {
  const spy = vi.spyOn(worktreeDeps, 'syncNodeModulesLinks').mockResolvedValue({ added: 0, removed: 0 });
  const t0 = 1_000_000;
  expect(ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w', now: t0 })).toBe(true);
  expect(ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w', now: t0 + 29_999 })).toBe(false);
  // A different worktree is throttled independently.
  expect(ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w2', now: t0 + 1 })).toBe(true);
  expect(ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w', now: t0 + 30_000 })).toBe(true);
  await tick();
  expect(spy).toHaveBeenCalledTimes(3);
  expect(ds.THROTTLE_MS).toBe(30_000);
});

test('a throwing sync never throws out', async () => {
  const spy = vi.spyOn(worktreeDeps, 'syncNodeModulesLinks').mockImplementation(() => { throw new Error('boom'); });
  expect(() => ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w' })).not.toThrow();
  await tick();
  await tick();
  expect(spy).toHaveBeenCalledTimes(1);
});

test('a rejecting sync is caught (no unhandled rejection)', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    vi.spyOn(worktreeDeps, 'syncNodeModulesLinks').mockRejectedValue(new Error('async boom'));
    expect(ds.syncEpicWorktreeDeps({ projectCwd: '/p', worktreeCwd: '/w' })).toBe(true);
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});
