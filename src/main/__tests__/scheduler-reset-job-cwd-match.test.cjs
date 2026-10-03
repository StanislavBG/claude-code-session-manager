/**
 * scheduler-reset-job-cwd-match.test.cjs — jobMatchesSlugAndCwd, the row-
 * match predicate shared by the `schedule:reset-job` IPC handler and
 * remote.resetJob (admin/MCP). Slugs carry no cwd salt — two different
 * projects can independently produce the identical slug — so both the
 * renderer-facing IPC path and the admin/MCP path must match on
 * slug + cwd when a cwd is given, not just slug, and must stay permissive
 * (slug-only) when no cwd is given, matching prior behaviour.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reset-job-cwd-match.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { jobMatchesSlugAndCwd } = require('../scheduler.cjs');

test('matches on slug alone when no cwd is given', () => {
  const job = { slug: 'my-slug', cwd: '/projects/a' };
  expect(jobMatchesSlugAndCwd(job, 'my-slug', undefined)).toBe(true);
  expect(jobMatchesSlugAndCwd(job, 'my-slug', null)).toBe(true);
  expect(jobMatchesSlugAndCwd(job, 'my-slug', '')).toBe(true);
});

test('requires BOTH slug and cwd to match when cwd is given', () => {
  const job = { slug: 'my-slug', cwd: '/projects/a' };
  expect(jobMatchesSlugAndCwd(job, 'my-slug', '/projects/a')).toBe(true);
  expect(jobMatchesSlugAndCwd(job, 'my-slug', '/projects/b')).toBe(false);
});

test('never matches a different slug, cwd filter or not', () => {
  const job = { slug: 'my-slug', cwd: '/projects/a' };
  expect(jobMatchesSlugAndCwd(job, 'other-slug', undefined)).toBe(false);
  expect(jobMatchesSlugAndCwd(job, 'other-slug', '/projects/a')).toBe(false);
});

test('two projects sharing an identical slug are disambiguated by cwd', () => {
  const jobA = { slug: 'collide', cwd: '/projects/a' };
  const jobB = { slug: 'collide', cwd: '/projects/b' };
  expect(jobMatchesSlugAndCwd(jobA, 'collide', '/projects/b')).toBe(false);
  expect(jobMatchesSlugAndCwd(jobB, 'collide', '/projects/b')).toBe(true);
});
