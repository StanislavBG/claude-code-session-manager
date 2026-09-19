/**
 * health-build-freshness.test.cjs — evaluateBuildFreshness separates
 * restart-needed (installed differs from running) from publish-needed
 * (repo HEAD differs from installed); both reported, never critical.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-build-freshness.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { evaluateBuildFreshness } = require('../health.cjs');

test('all shas equal → nothing needed', () => {
  const r = evaluateBuildFreshness({ running: 'abc1234', installedOnDisk: 'abc1234', repoHead: 'abc1234' });
  expect(r).toMatchObject({ ok: true, restartNeeded: false, publishNeeded: false });
});

test('installed differs from running → restart needed only', () => {
  const r = evaluateBuildFreshness({ running: 'aaa1111', installedOnDisk: 'bbb2222', repoHead: 'bbb2222' });
  expect(r).toMatchObject({ ok: true, restartNeeded: true, publishNeeded: false });
});

test('repo HEAD differs from installed → publish needed only', () => {
  const r = evaluateBuildFreshness({ running: 'bbb2222', installedOnDisk: 'bbb2222', repoHead: 'ccc3333' });
  expect(r).toMatchObject({ ok: true, restartNeeded: false, publishNeeded: true });
});

test('both differ → both reported, still ok (non-critical)', () => {
  const r = evaluateBuildFreshness({ running: 'aaa1111', installedOnDisk: 'bbb2222', repoHead: 'ccc3333' });
  expect(r).toMatchObject({ ok: true, restartNeeded: true, publishNeeded: true });
  expect(r.note).toMatch(/restart needed/);
  expect(r.note).toMatch(/publish needed/);
});

test('unknown inputs never claim a difference; short/long sha prefixes match', () => {
  expect(evaluateBuildFreshness({})).toMatchObject({ restartNeeded: false, publishNeeded: false });
  expect(evaluateBuildFreshness({ running: null, installedOnDisk: 'abc1234', repoHead: 'abc1234567890' }))
    .toMatchObject({ restartNeeded: false, publishNeeded: false });
});
