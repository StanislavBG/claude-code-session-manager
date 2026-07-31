/**
 * health-prd-migration.test.cjs — stranded-PRD-migration health signal
 * (behind two real 2026-07-31 incidents: a single stranded PRD causing an
 * instant ENOENT job failure, and 223 stranded legacy PRDs + a missing
 * history.jsonl resurrecting 189 completed jobs). Exercises
 * evaluatePrdMigrationHealth() directly since it's pure — no need to spawn
 * the full check() (which shells out to npm run typecheck) to cover this.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-prd-migration.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { evaluatePrdMigrationHealth } = require('../health.cjs');

const LEGACY_DIR = '/home/user/.claude/session-manager/scheduled-plans/prds';

test('reports ok when nothing is stranded', () => {
  const result = evaluatePrdMigrationHealth({ moved: 3, skipped: 0, unresolved: [] }, LEGACY_DIR);
  expect(result.ok).toBe(true);
  expect(result.strandedCount).toBe(0);
  expect(result.legacyDir).toBe(LEGACY_DIR);
  expect(result.unresolved).toBeUndefined();
});

test('reports RED with count and legacy dir path when files are stranded', () => {
  const unresolved = [
    { file: '01-stuck.md', reason: 'no cwd in frontmatter' },
    { file: '02-stuck.md', reason: 'cwd does not exist on disk' },
  ];
  const result = evaluatePrdMigrationHealth({ moved: 0, skipped: 0, unresolved }, LEGACY_DIR);
  expect(result.ok).toBe(false);
  expect(result.strandedCount).toBe(2);
  expect(result.legacyDir).toBe(LEGACY_DIR);
  expect(result.unresolved).toEqual(unresolved);
});
