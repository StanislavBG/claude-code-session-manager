/**
 * epicWorktreeBoot.test.cjs — unit tests for reconcileEpicWorktreesOnBoot
 * (PRD 1033), which wires gitWorktree.cjs's `isLive` predicate (built but
 * left unwired by PRD 1032) to a project's real active-index.json: a
 * worktree survives boot reconciliation exactly when its owning Epic is
 * still 'active' there.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicWorktreeBoot.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { reconcileEpicWorktreesOnBoot } = require('../epicWorktreeBoot.cjs');

test('reaps a worktree whose owning Epic is not active (missing from the index)', async () => {
  const calls = [];
  const reconcileWorktreesOnBoot = async (cwds, opts) => {
    calls.push({ cwds, kind: opts.kind });
    // Simulate gitWorktree.cjs's real loop: it asks isLive per key found on disk.
    expect(await opts.isLive('orphaned-epic')).toBe(false);
  };
  await reconcileEpicWorktreesOnBoot(['/projects/foo'], {
    readActiveIndex: () => ({ sessions: {} }),
    reconcileWorktreesOnBoot,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe('epic');
});

test('a worktree belonging to a currently-active Epic survives (isLive returns true)', async () => {
  const reconcileWorktreesOnBoot = async (cwds, opts) => {
    expect(await opts.isLive('still-active-epic')).toBe(true);
    expect(await opts.isLive('completed-epic')).toBe(false);
    expect(await opts.isLive('unknown-epic')).toBe(false);
  };
  await reconcileEpicWorktreesOnBoot(['/projects/foo'], {
    readActiveIndex: (cwd) => {
      expect(cwd).toBe('/projects/foo');
      return {
        sessions: {
          'still-active-epic': { id: 'still-active-epic', status: 'active' },
          'completed-epic': { id: 'completed-epic', status: 'completed' },
        },
      };
    },
    reconcileWorktreesOnBoot,
  });
});

test('sweeps every cwd given, each with its own active-index read', async () => {
  const seenCwds = [];
  await reconcileEpicWorktreesOnBoot(['/projects/a', '/projects/b'], {
    readActiveIndex: (cwd) => {
      seenCwds.push(cwd);
      return { sessions: {} };
    },
    reconcileWorktreesOnBoot: async () => {},
  });
  expect(seenCwds).toEqual(['/projects/a', '/projects/b']);
});

test('never throws when a cwd has no active-index.json yet (readActiveIndex throws)', async () => {
  const reconcileWorktreesOnBoot = async (cwds, opts) => {
    expect(await opts.isLive('any-epic')).toBe(false);
  };
  await expect(
    reconcileEpicWorktreesOnBoot(['/projects/no-index-yet'], {
      readActiveIndex: () => { throw new Error('ENOENT'); },
      reconcileWorktreesOnBoot,
    }),
  ).resolves.toBeUndefined();
});

test('ignores falsy entries in the cwd list', async () => {
  const seenCwds = [];
  await reconcileEpicWorktreesOnBoot([null, '/projects/a', undefined, ''], {
    readActiveIndex: (cwd) => { seenCwds.push(cwd); return { sessions: {} }; },
    reconcileWorktreesOnBoot: async () => {},
  });
  expect(seenCwds).toEqual(['/projects/a']);
});

// ─── real git repo + real active-index.json, default (unstubbed) deps ─────

test('end-to-end with default deps: a worktree of a still-active Epic survives, an orphaned one is reaped', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const gitWorktree = require('../gitWorktree.cjs');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epicworktreeboot-e2e-'));
  const repoCwd = path.join(tmpRoot, 'repo');
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repoCwd, { recursive: true });
  git(['init', '-q'], repoCwd);
  git(['config', 'user.email', 'test@example.com'], repoCwd);
  git(['config', 'user.name', 'Test'], repoCwd);
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'initial'], repoCwd);
  gitWorktree._resetActiveWorktreeCountForTests('epic', 0);

  try {
    const liveEpicId = 'e2e-live-epic';
    const orphanedEpicId = 'e2e-orphaned-epic';
    const live = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: liveEpicId });
    const orphaned = await gitWorktree.createEpicWorktree({ cwd: repoCwd, epicId: orphanedEpicId });
    expect(live.ok).toBe(true);
    expect(orphaned.ok).toBe(true);
    gitWorktree._resetActiveWorktreeCountForTests('epic', 0);

    const indexDir = path.join(repoCwd, 'session-manager-operations', 'prompt-sessions');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      path.join(indexDir, 'active-index.json'),
      JSON.stringify({
        sessions: {
          [liveEpicId]: { id: liveEpicId, status: 'active' },
          // orphanedEpicId deliberately absent — simulates a completed/deleted Epic.
        },
        events: {},
      }),
    );

    await reconcileEpicWorktreesOnBoot([repoCwd]);

    expect(fs.existsSync(live.dir)).toBe(true);
    expect(fs.existsSync(orphaned.dir)).toBe(false);

    await gitWorktree.cleanupEpicWorktree({ cwd: repoCwd, dir: live.dir, branch: live.branch });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
