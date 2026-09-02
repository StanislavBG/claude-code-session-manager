/**
 * scheduler-foreign-wip-manifest.test.cjs — capDirtyPaths/buildForeignWipSection,
 * the pure helpers behind the pre-run foreign-WIP manifest injected into the
 * executor prompt (see the "starry-night-ships PRD 148" postmortem: a job
 * running in a shared or WIP-carrying tree must be told explicitly which
 * paths it does not own, rather than having to bisect by content).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-foreign-wip-manifest.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  capDirtyPaths,
  buildForeignWipSection,
  PRE_RUN_DIRTY_PATHS_CAP,
  FOREIGN_WIP_DELIMITER,
  FOREIGN_WIP_END_DELIMITER,
} = require('../scheduler.cjs');

test('capDirtyPaths: [] for null/undefined/empty input', () => {
  expect(capDirtyPaths(null)).toEqual([]);
  expect(capDirtyPaths(undefined)).toEqual([]);
  expect(capDirtyPaths([])).toEqual([]);
});

test('capDirtyPaths: returns the list unchanged when under the cap', () => {
  expect(capDirtyPaths(['a.js', 'b.js'])).toEqual(['a.js', 'b.js']);
});

test('capDirtyPaths: truncates at the cap and appends a "+N more" marker', () => {
  const many = Array.from({ length: PRE_RUN_DIRTY_PATHS_CAP + 7 }, (_, i) => `file-${i}.txt`);
  const capped = capDirtyPaths(many);
  expect(capped).toHaveLength(PRE_RUN_DIRTY_PATHS_CAP + 1);
  expect(capped.slice(0, PRE_RUN_DIRTY_PATHS_CAP)).toEqual(many.slice(0, PRE_RUN_DIRTY_PATHS_CAP));
  expect(capped[PRE_RUN_DIRTY_PATHS_CAP]).toBe('+7 more');
});

test('buildForeignWipSection: "" when both lists are empty/absent (clean spawn) — zero prompt tokens added', () => {
  expect(buildForeignWipSection({})).toBe('');
  expect(buildForeignWipSection({ preRunDirtyPaths: [], carriedPaths: [] })).toBe('');
  expect(buildForeignWipSection()).toBe('');
});

test('buildForeignWipSection: shared dirty tree emits the manifest with the delimiter, paths verbatim, and do-not-touch wording', () => {
  const section = buildForeignWipSection({ preRunDirtyPaths: ['src/foo.ts', 'src/bar.ts'] });
  expect(section).toContain(FOREIGN_WIP_DELIMITER);
  expect(section).toContain(FOREIGN_WIP_END_DELIMITER);
  expect(section).toContain('src/foo.ts');
  expect(section).toContain('src/bar.ts');
  expect(section).toMatch(/SHARED working tree/);
  expect(section).toMatch(/not this job's work/i);
  expect(section).toMatch(/do not stage, commit, revert, or stash/i);
  expect(section).toMatch(/not this job's regression/i);
});

test('buildForeignWipSection: carriedPaths (PRD 1094 base WIP) emits carry-over wording, not the shared-tree wording', () => {
  const section = buildForeignWipSection({ carriedPaths: ['config/settings.json'] });
  expect(section).toContain('config/settings.json');
  expect(section).toMatch(/isolated git worktree/i);
  expect(section).toMatch(/authoritative copy.*main tree/i);
  expect(section).not.toMatch(/SHARED working tree/);
});

test('buildForeignWipSection: carriedPaths takes precedence over preRunDirtyPaths when both are somehow present', () => {
  const section = buildForeignWipSection({
    carriedPaths: ['carried.ts'],
    preRunDirtyPaths: ['dirty.ts'],
  });
  expect(section).toContain('carried.ts');
  expect(section).not.toContain('dirty.ts');
  expect(section).toMatch(/isolated git worktree/i);
});

test('buildForeignWipSection: isolated-clean (worktree ok, no carried WIP) emits nothing', () => {
  expect(buildForeignWipSection({ carriedPaths: [] })).toBe('');
});
