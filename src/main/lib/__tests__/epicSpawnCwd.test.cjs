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
