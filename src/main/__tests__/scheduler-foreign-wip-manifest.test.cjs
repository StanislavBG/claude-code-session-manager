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
  FOREIGN_WIP_SECTION_MAX_BYTES,
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

const pathLines = (section) => section.split('\n').filter((l) => /^  \S/.test(l) && !l.startsWith('  ... and'));

test('buildForeignWipSection: 5,000 carried paths are capped by count and bytes with a per-directory summary', () => {
  const carried = [
    ...Array.from({ length: 4900 }, (_, i) => `session-manager-operations/scheduler/prds/.reserved-${i}`),
    ...Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`),
  ];
  const section = buildForeignWipSection({ carriedPaths: carried });
  expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(FOREIGN_WIP_SECTION_MAX_BYTES);
  expect(section.split('\n')[0]).toBe(FOREIGN_WIP_DELIMITER);
  expect(section.split('\n').pop()).toBe(FOREIGN_WIP_END_DELIMITER);
  expect(pathLines(section).map((l) => l.trim())).toEqual(carried.slice(0, 200));
  expect(section).toContain('... and 4,800 more path(s) not listed:');
  expect(section).toContain('4,700 under session-manager-operations/scheduler/prds/');
  expect(section).toContain('100 under src/');
});

test('buildForeignWipSection: long paths are limited by the byte budget, remainder summarised', () => {
  const carried = Array.from({ length: 200 }, (_, i) => `d/${String(i).padStart(3, '0')}${'x'.repeat(295)}`);
  const section = buildForeignWipSection({ carriedPaths: carried });
  expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(FOREIGN_WIP_SECTION_MAX_BYTES);
  const listed = pathLines(section).length;
  expect(listed).toBeLessThan(200);
  expect(section).toContain(`... and ${(200 - listed).toLocaleString('en-US')} more path(s) not listed: ${(200 - listed).toLocaleString('en-US')} under d/`);
});

test('buildForeignWipSection: capDirtyPaths "+N more" marker is never a path; its N joins the omitted count', () => {
  const dirty = capDirtyPaths(Array.from({ length: 5000 }, (_, i) => `a/f${i}`));
  const section = buildForeignWipSection({ preRunDirtyPaths: dirty });
  expect(section).not.toContain('+4800 more');
  expect(pathLines(section)).toHaveLength(200);
  expect(section).toContain('... and 4,800 more path(s) not listed');
  expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(FOREIGN_WIP_SECTION_MAX_BYTES);
});

test('buildForeignWipSection: more than 5 directories sum the rest as "elsewhere"; root files group as (repo root)', () => {
  const paths = [...Array.from({ length: 200 }, (_, i) => `keep${i}`),
    ...['a/', 'b/', 'c/', 'd/', 'e/', 'f/'].flatMap((d, k) => Array.from({ length: 10 - k }, (_, i) => `${d}${i}`)),
    'root.txt'];
  const section = buildForeignWipSection({ carriedPaths: paths });
  expect(section).toContain('10 under a/');
  expect(section).toContain('6 under e/');
  expect(section).not.toContain('under f/');
  expect(section).toMatch(/, \d+ elsewhere/);
});
