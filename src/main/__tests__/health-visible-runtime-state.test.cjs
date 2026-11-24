/**
 * health-visible-runtime-state.test.cjs — evaluateVisibleRuntimeState warns
 * (never flips ok) for each project whose runtime files git can see.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-visible-runtime-state.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { evaluateVisibleRuntimeState } = require('../health.cjs');

test('all-zero counts → plain ok, no issues', () => {
  const r = evaluateVisibleRuntimeState([{ cwd: '/p/a', count: 0 }, { cwd: '/p/b', count: 0 }]);
  expect(r.component).toEqual({ ok: true });
  expect(r.issues).toEqual([]);
  expect(evaluateVisibleRuntimeState([])).toEqual({ component: { ok: true }, issues: [] });
});

test('one hit → warn component naming that project, one issue', () => {
  const r = evaluateVisibleRuntimeState([{ cwd: '/p/a', count: 0 }, { cwd: '/p/b', count: 3 }]);
  expect(r.component).toEqual({ ok: true, warn: true, projects: [{ cwd: '/p/b', count: 3 }] });
  expect(r.issues).toEqual(['warn: /p/b has 3 Session Manager runtime file(s) git can see (missing self-ignore)']);
});

test('several hits → one issue per project, ok stays true', () => {
  const r = evaluateVisibleRuntimeState([
    { cwd: '/p/a', count: 1 },
    { cwd: '/p/b', count: 0 },
    { cwd: '/p/c', count: 12 },
  ]);
  expect(r.component.ok).toBe(true);
  expect(r.component.warn).toBe(true);
  expect(r.component.projects).toEqual([{ cwd: '/p/a', count: 1 }, { cwd: '/p/c', count: 12 }]);
  expect(r.issues).toEqual([
    'warn: /p/a has 1 Session Manager runtime file(s) git can see (missing self-ignore)',
    'warn: /p/c has 12 Session Manager runtime file(s) git can see (missing self-ignore)',
  ]);
});
