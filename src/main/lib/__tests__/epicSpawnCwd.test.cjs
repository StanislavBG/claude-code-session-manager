/**
 * epicSpawnCwd.test.cjs — unit tests for resolveEpicSpawnCwd, the shared
 * spawn-cwd resolver both pty.cjs's Terminal spawn and chatRunner.cjs's
 * headless spawn use to point an Epic's actual child process at its
 * isolated git worktree (PRD 1033), while every other cwd usage stays the
 * real project cwd (see the module's own "ops-root hazard" header comment).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicSpawnCwd.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { resolveEpicSpawnCwd } = require('../epicSpawnCwd.cjs');

function stubReadActiveIndex(sessions) {
  return () => ({ sessions });
}

// resolveEpicSpawnCwd stats worktree.dir before returning it (a persisted
// path outlives its checkout across a reboot/tmp sweep, a clone onto another
// machine, or a manual prune). These fixtures name paths that don't exist on
// the test host, so inject a stat stub saying they do; the "vanished dir"
// tests at the bottom exercise the real fallback.
const statOk = () => ({ isDirectory: () => true });
const statGone = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

test('returns worktree.dir when the matching Epic (by claudeSessionId) has one', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'sess-1',
    deps: {
      readActiveIndex: stubReadActiveIndex({
        'epic-1': {
          id: 'epic-1',
          claudeSessionId: 'sess-1',
          worktree: { dir: '/tmp/sm-epic-worktrees/abc/epic-1', branch: 'sm-epic/epic-1', baseCwd: '/projects/foo', status: 'active' },
        },
      }),
      statSync: statOk,
    },
  });
  expect(result).toBe('/tmp/sm-epic-worktrees/abc/epic-1');
});

test('falls back to cwd unchanged when the matching Epic has no worktree field', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'sess-1',
    deps: {
      readActiveIndex: stubReadActiveIndex({
        'epic-1': { id: 'epic-1', claudeSessionId: 'sess-1' },
      }),
    },
  });
  expect(result).toBe('/projects/foo');
});

test('falls back to cwd unchanged when no session matches claudeSessionId (non-Epic tab)', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'some-other-session',
    deps: {
      readActiveIndex: stubReadActiveIndex({
        'epic-1': {
          id: 'epic-1',
          claudeSessionId: 'sess-1',
          worktree: { dir: '/tmp/sm-epic-worktrees/abc/epic-1', branch: 'sm-epic/epic-1', baseCwd: '/projects/foo', status: 'active' },
        },
      }),
      statSync: statOk,
    },
  });
  expect(result).toBe('/projects/foo');
});

test('falls back to cwd unchanged when cwd or claudeSessionId is missing', () => {
  expect(resolveEpicSpawnCwd({ cwd: '/projects/foo', claudeSessionId: '' })).toBe('/projects/foo');
  expect(resolveEpicSpawnCwd({ cwd: '', claudeSessionId: 'sess-1' })).toBe('');
  expect(resolveEpicSpawnCwd({})).toBeUndefined();
});

test('returns worktree.dir for a conflicted (needs_merge_resolution) Epic too — same PTY-into-worktree path a human uses to resolve it manually (PRD 1034)', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'sess-1',
    deps: {
      readActiveIndex: stubReadActiveIndex({
        'epic-1': {
          id: 'epic-1',
          claudeSessionId: 'sess-1',
          worktree: {
            dir: '/tmp/sm-epic-worktrees/abc/epic-1',
            branch: 'sm-epic/epic-1',
            baseCwd: '/projects/foo',
            status: 'needs_merge_resolution',
          },
        },
      }),
      statSync: statOk,
    },
  });
  expect(result).toBe('/tmp/sm-epic-worktrees/abc/epic-1');
});

test('never throws when the active-index read itself throws — falls back to cwd', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'sess-1',
    deps: {
      readActiveIndex: () => { throw new Error('disk read failed'); },
    },
  });
  expect(result).toBe('/projects/foo');
});

// ─── persisted worktree.dir outliving its checkout (2026-08-13) ─────────────
//
// worktree.dir is an absolute os.tmpdir() path persisted onto the Epic record
// in active-index.json — a git-TRACKED file. It therefore routinely names a
// directory that no longer exists: /tmp is cleared on boot on most Linux
// distros and macOS (this host: `D /tmp 1777 root root 30d`), Epics are
// deliberately long-lived, and a clone on another machine carries a path built
// from the ORIGINAL machine's tmpdir and a sha1 of its project cwd. Handing
// that to node-pty/child_process as a spawn cwd fails the spawn outright, so
// the resolver falls back to the shared project tree instead.

const WORKTREE_SESSIONS = {
  'epic-1': {
    id: 'epic-1',
    claudeSessionId: 'sess-1',
    worktree: {
      dir: '/tmp/session-manager-epic-worktrees/deadbeef/epic-1',
      branch: 'sm-epic/epic-1',
      baseCwd: '/projects/foo',
      status: 'active',
    },
  },
};

test('falls back to the project cwd when the persisted worktree dir no longer exists (reboot / tmp sweep)', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'sess-1',
    deps: { readActiveIndex: stubReadActiveIndex(WORKTREE_SESSIONS), statSync: statGone },
  });
  expect(result).toBe('/projects/foo');
});

test('falls back when worktree.dir exists but is a FILE, not a directory', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'sess-1',
    deps: {
      readActiveIndex: stubReadActiveIndex(WORKTREE_SESSIONS),
      statSync: () => ({ isDirectory: () => false }),
    },
  });
  expect(result).toBe('/projects/foo');
});

test('a stat that throws something other than ENOENT still falls back rather than propagating', () => {
  const result = resolveEpicSpawnCwd({
    cwd: '/projects/foo',
    claudeSessionId: 'sess-1',
    deps: {
      readActiveIndex: stubReadActiveIndex(WORKTREE_SESSIONS),
      statSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    },
  });
  expect(result).toBe('/projects/foo');
});

test('a real, existing directory IS returned — the check gates on disk state, not on the field being set', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const realDir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'sm-epicspawn-real-'));
  try {
    const result = resolveEpicSpawnCwd({
      cwd: '/projects/foo',
      claudeSessionId: 'sess-1',
      deps: {
        readActiveIndex: stubReadActiveIndex({
          'epic-1': { id: 'epic-1', claudeSessionId: 'sess-1', worktree: { dir: realDir, branch: 'b', baseCwd: '/projects/foo', status: 'active' } },
        }),
        // no statSync stub — exercises the real fs.statSync default
      },
    });
    expect(result).toBe(realDir);
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});
