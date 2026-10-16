/**
 * prdWorktreeReach.test.cjs — unit tests for the PRD worktree-reach rule.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdWorktreeReach.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { extractRepoPathCandidates, worktreeReachWarnings } = require('../lib/prd/prdWorktreeReach.cjs');

const BURROW_1516_AC =
  'The tracker reads `downloads/fb-tracker.db` (data/pipeline-schedule.yaml drives it), and '
  + '"scripts/install-cron.sh" installs the cron entry, then prints the result.';

test('extracts candidates from the burrow 1516 AC text', () => {
  const found = extractRepoPathCandidates(BURROW_1516_AC);
  expect(found).toContain('downloads/fb-tracker.db');
  expect(found).toContain('scripts/install-cron.sh');
  expect(found).toContain('data/pipeline-schedule.yaml');
});

test('excludes absolute, home, env, flag, URL and dotdot tokens', () => {
  const text = '/etc/hosts ~/x/y $HOME/a/b --out=a/b https://example.com/a ../up/x a/../b ok/file.txt';
  expect(extractRepoPathCandidates(text)).toEqual(['ok/file.txt']);
});

test('dedupes, requires a slash, strips trailing punctuation, caps at 200', () => {
  expect(extractRepoPathCandidates('word a/b. a/b, (a/b) a/b;')).toEqual(['a/b']);
  const many = Array.from({ length: 300 }, (_, i) => `d/f${i}.txt`).join(' ');
  expect(extractRepoPathCandidates(many)).toHaveLength(200);
  expect(extractRepoPathCandidates(null)).toEqual([]);
});

test('empty ignoredPaths yields no warnings', () => {
  expect(worktreeReachWarnings({ goal: 'x downloads/a.db' }, [])).toEqual([]);
  expect(worktreeReachWarnings({ goal: 'x' }, undefined)).toEqual([]);
});

test('dep-dir ignored paths are exempt', () => {
  expect(worktreeReachWarnings({ implementationNotes: 'use .venv/bin/python' }, ['.venv/bin/python'])).toEqual([]);
  expect(worktreeReachWarnings({ goal: 'node_modules/x/y' }, ['node_modules/x/y'])).toEqual([]);
});

test('warns once, naming the ignored paths, for non-dep ignored paths', () => {
  const w = worktreeReachWarnings(
    { goal: 'g', acceptanceCriteria: [BURROW_1516_AC], implementationNotes: '' },
    ['downloads/fb-tracker.db', '.venv/bin/python'],
  );
  expect(w).toHaveLength(1);
  expect(w[0]).toContain('downloads/fb-tracker.db');
  expect(w[0]).not.toContain('.venv/bin/python');
  expect(w[0]).toMatch(/isolated worktree/);
  expect(w[0]).toMatch(/absolute path/);
  expect(w[0]).toMatch(/artifact-only/);
  expect(w[0]).toMatch(/PRD_AUTHORING\.md section 7/);
});

test('caps the named paths at 5', () => {
  const paths = Array.from({ length: 8 }, (_, i) => `out/f${i}.db`);
  const w = worktreeReachWarnings({ goal: paths.join(' ') }, paths);
  expect(w).toHaveLength(1);
  for (let i = 0; i < 5; i++) expect(w[0]).toContain(`out/f${i}.db`);
  for (let i = 5; i < 8; i++) expect(w[0]).not.toContain(`out/f${i}.db`);
});
