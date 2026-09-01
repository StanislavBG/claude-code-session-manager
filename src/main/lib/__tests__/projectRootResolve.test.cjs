/**
 * projectRootResolve.test.cjs — resolveProjectContext (PRD: worktree-cwd
 * Epic-lookup hazard). Exercises the resolver purely in-process with injected
 * deps (no Electron, no real git worktrees) — see prdCreate.test.cjs for the
 * end-to-end fixture reproducing the live starry-night-ships shape.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/projectRootResolve.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const { resolveProjectContext } = require('../projectRootResolve.cjs');

function makeDeps({ projectRootOfImpl, allCwds = [], indexes = {}, ephemeral = [] } = {}) {
  return {
    projectRootOf: projectRootOfImpl || ((p) => p),
    allProjectCwds: () => allCwds,
    readActiveIndex: (cwd) => ({ sessions: indexes[cwd] || {}, events: {} }),
    isEphemeralCwd: (cwd) => ephemeral.includes(cwd),
    warn: vi.fn(),
  };
}

test('a plain project root (no worktree, no ops-internal segment) is returned unchanged', () => {
  const deps = makeDeps();
  const result = resolveProjectContext({ cwd: '/home/bilko/Projects/some-app' }, deps);
  expect(result).toEqual({ cwd: '/home/bilko/Projects/some-app', epicId: null, epicCwd: null, source: 'cwd' });
});

test('a worktree cwd normalizes to the main tree', () => {
  const deps = makeDeps({
    projectRootOfImpl: (p) => (p.startsWith('/tmp/worktree') ? '/home/bilko/Projects/starry-night-ships' : p),
  });
  const result = resolveProjectContext({ cwd: '/tmp/worktree/abc/epic-1' }, deps);
  expect(result.cwd).toBe('/home/bilko/Projects/starry-night-ships');
  expect(result.source).toBe('cwd');
});

test('an ops-internal cwd normalizes to the project root', () => {
  const deps = makeDeps({
    projectRootOfImpl: (p) => (p.includes('session-manager-operations') ? '/home/bilko/Projects/foo' : p),
  });
  const result = resolveProjectContext({ cwd: '/home/bilko/Projects/foo/session-manager-operations/scheduler/state' }, deps);
  expect(result.cwd).toBe('/home/bilko/Projects/foo');
});

test('Epic found in the normalized cwd\'s own active-index — source epic-index', () => {
  const deps = makeDeps({
    indexes: {
      '/home/bilko/Projects/foo': { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-1', status: 'active' } },
    },
  });
  const result = resolveProjectContext({ cwd: '/home/bilko/Projects/foo', originClaudeSessionId: 'sess-1' }, deps);
  expect(result).toEqual({ cwd: '/home/bilko/Projects/foo', epicId: 'epic-1', epicCwd: '/home/bilko/Projects/foo', source: 'epic-index' });
});

test('Epic found only via cross-project scan — epicCwd wins over the supplied cwd', () => {
  const deps = makeDeps({
    allCwds: ['/home/bilko/Projects/foo', '/home/bilko/Projects/bar'],
    indexes: {
      '/home/bilko/Projects/bar': { 'epic-2': { id: 'epic-2', claudeSessionId: 'sess-2', status: 'active' } },
    },
  });
  const result = resolveProjectContext({ cwd: '/home/bilko/Projects/foo', originClaudeSessionId: 'sess-2' }, deps);
  expect(result.epicId).toBe('epic-2');
  expect(result.epicCwd).toBe('/home/bilko/Projects/bar');
  expect(result.cwd).toBe('/home/bilko/Projects/bar');
  expect(result.source).toBe('cross-project-scan');
});

test('no match anywhere → epicId null, cwd unchanged', () => {
  const deps = makeDeps({ allCwds: ['/home/bilko/Projects/foo'] });
  const result = resolveProjectContext({ cwd: '/home/bilko/Projects/foo', originClaudeSessionId: 'sess-unknown' }, deps);
  expect(result).toEqual({ cwd: '/home/bilko/Projects/foo', epicId: null, epicCwd: null, source: 'cwd' });
});

test('explicit epicId (sourcePromptId) resolves cwd when no cwd was supplied at all', () => {
  const deps = makeDeps({
    allCwds: ['/home/bilko/Projects/foo'],
    indexes: {
      '/home/bilko/Projects/foo': { 'epic-3': { id: 'epic-3', claudeSessionId: 'sess-3', status: 'proposed' } },
    },
  });
  const result = resolveProjectContext({ epicId: 'epic-3' }, deps);
  expect(result.cwd).toBe('/home/bilko/Projects/foo');
  expect(result.epicId).toBe('epic-3');
});

test('duplicate claudeSessionId across two projects: prefers the non-ephemeral, status=active row and warns naming both', () => {
  const deps = makeDeps({
    allCwds: ['/tmp/session-manager-epic-worktrees/abc/epic-1', '/home/bilko/Projects/starry-night-ships'],
    indexes: {
      '/tmp/session-manager-epic-worktrees/abc/epic-1': {
        'epic-1': { id: 'epic-1', claudeSessionId: 'sess-dup', status: 'proposed' },
      },
      '/home/bilko/Projects/starry-night-ships': {
        'epic-1': { id: 'epic-1', claudeSessionId: 'sess-dup', status: 'active' },
      },
    },
    ephemeral: ['/tmp/session-manager-epic-worktrees/abc/epic-1'],
  });
  const result = resolveProjectContext({ originClaudeSessionId: 'sess-dup' }, deps);
  expect(result.epicCwd).toBe('/home/bilko/Projects/starry-night-ships');
  expect(result.source).toBe('cross-project-scan');
  expect(deps.warn).toHaveBeenCalledTimes(1);
  const warnMsg = deps.warn.mock.calls[0][0];
  expect(warnMsg).toContain('/tmp/session-manager-epic-worktrees/abc/epic-1');
  expect(warnMsg).toContain('/home/bilko/Projects/starry-night-ships');
});

test('an originProjectRoot hint outranks the supplied cwd, but a resolved Epic still outranks the hint', () => {
  const deps = makeDeps({
    indexes: {
      '/home/bilko/Projects/hinted': { 'epic-4': { id: 'epic-4', claudeSessionId: 'sess-4', status: 'active' } },
    },
  });
  const noEpic = resolveProjectContext({ cwd: '/home/bilko/Projects/guessed', originProjectRoot: '/home/bilko/Projects/hinted' }, deps);
  expect(noEpic.cwd).toBe('/home/bilko/Projects/hinted');

  const withEpic = resolveProjectContext(
    { cwd: '/home/bilko/Projects/guessed', originProjectRoot: '/home/bilko/Projects/hinted', originClaudeSessionId: 'sess-4' },
    deps,
  );
  expect(withEpic.cwd).toBe('/home/bilko/Projects/hinted');
  expect(withEpic.epicId).toBe('epic-4');
});

test('never throws on missing cwd/originClaudeSessionId/epicId — returns an all-null result', () => {
  const deps = makeDeps();
  expect(resolveProjectContext({}, deps)).toEqual({ cwd: null, epicId: null, epicCwd: null, source: 'cwd' });
  expect(resolveProjectContext(undefined, deps)).toEqual({ cwd: null, epicId: null, epicCwd: null, source: 'cwd' });
});

test('bounded: reads each candidate project\'s active-index exactly once per call', () => {
  const readActiveIndex = vi.fn((cwd) => ({ sessions: {}, events: {} }));
  const deps = {
    projectRootOf: (p) => p,
    allProjectCwds: () => ['/home/bilko/Projects/a', '/home/bilko/Projects/b', '/home/bilko/Projects/c'],
    readActiveIndex,
    isEphemeralCwd: () => false,
    warn: vi.fn(),
  };
  resolveProjectContext({ cwd: '/home/bilko/Projects/a', originClaudeSessionId: 'sess-x' }, deps);
  expect(readActiveIndex).toHaveBeenCalledTimes(3);
  const calledCwds = readActiveIndex.mock.calls.map((c) => c[0]);
  expect(new Set(calledCwds).size).toBe(3);
});
