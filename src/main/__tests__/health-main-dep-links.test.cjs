/**
 * health-main-dep-links.test.cjs — evaluateMainDepLinks reports only
 * worktree-escaping / dangling node_modules links; always non-critical.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-main-dep-links.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { evaluateMainDepLinks } = require('../health.cjs');

test('empty input → checked 0, no issues', () => {
  const r = evaluateMainDepLinks([]);
  expect(r.component).toEqual({ ok: true, checked: 0, broken: [] });
  expect(r.issues).toEqual([]);
});

test('ok + links-into-worktree → one issue naming that cwd', () => {
  const r = evaluateMainDepLinks([
    { cwd: '/p/good', health: { ok: true } },
    { cwd: '/p/bad', health: { ok: false, reason: 'links-into-worktree', missing: ['a', 'b', 'c', 'd', 'e', 'f'] } },
  ]);
  expect(r.component.checked).toBe(2);
  expect(r.component.broken).toHaveLength(1);
  expect(r.issues).toHaveLength(1);
  expect(r.issues[0]).toContain('/p/bad');
  expect(r.issues[0]).toContain('links-into-worktree');
  expect(r.issues[0]).toContain('a, b, c, d, e');
  expect(r.issues[0]).not.toContain('f)');
  expect(r.issues[0]).toContain('CI=1 pnpm install --offline --frozen-lockfile');
});

test('not-pnpm and unresolved-deps produce no issue; ok always true', () => {
  const r = evaluateMainDepLinks([
    { cwd: '/p/a', health: { ok: true, skipped: 'not-pnpm' } },
    { cwd: '/p/b', health: { ok: false, reason: 'unresolved-deps', missing: ['x'] } },
    { cwd: '/p/c', health: { ok: false, reason: 'dangling-links', missing: ['y'] } },
  ]);
  expect(r.issues).toHaveLength(1);
  expect(r.issues[0]).toContain('/p/c');
  expect(r.component.ok).toBe(true);
});
