/**
 * scheduler-meta-code-sha.test.cjs — unit tests for the SCHEDULER_BOOTED_AT /
 * SCHEDULER_CODE_SHA constants stamped into every run's meta sidecar (PRD
 * 812-fix-commit-guard-retry-on-worktree-ref-visibility-delay): a stale
 * scheduler process is otherwise invisible in the run record, which cost a
 * full investigation to diagnose a false pass_no_commit.
 *
 * SCHEDULER_CODE_SHA now resolves through src/main/lib/buildIdentity.cjs
 * (build-identity-stamp PRD): a production npx install ships no .git, so a
 * runtime `git rev-parse` was structurally always null there — this file
 * used to accept that null unconditionally, which made the dead stamp green
 * forever. With src/main/build-info.json present (ensured below — the exact
 * artifact scripts/write-build-info.cjs bakes at publish time), the sha must
 * be real.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-meta-code-sha.test.cjs
 */

'use strict';

import { test, expect, afterAll } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const BUILD_INFO_PATH = path.join(__dirname, '..', 'build-info.json');
const preexistingBuildInfo = fs.existsSync(BUILD_INFO_PATH) ? fs.readFileSync(BUILD_INFO_PATH, 'utf8') : null;
if (preexistingBuildInfo === null) {
  // eslint-disable-next-line global-require
  require('../../../scripts/write-build-info.cjs').writeBuildInfo();
}

const { SCHEDULER_BOOTED_AT, SCHEDULER_CODE_SHA } = require('../scheduler.cjs');

afterAll(() => {
  if (preexistingBuildInfo === null) fs.rmSync(BUILD_INFO_PATH, { force: true });
  else fs.writeFileSync(BUILD_INFO_PATH, preexistingBuildInfo);
});

test('SCHEDULER_BOOTED_AT is a valid ISO date string', () => {
  expect(typeof SCHEDULER_BOOTED_AT).toBe('string');
  expect(Number.isNaN(new Date(SCHEDULER_BOOTED_AT).getTime())).toBe(false);
});

test('SCHEDULER_CODE_SHA is a real short git hex SHA when build-info.json is present — never null', () => {
  expect(SCHEDULER_CODE_SHA).toMatch(/^[0-9a-f]{7,40}$/);
});
