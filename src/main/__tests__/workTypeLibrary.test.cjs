/**
 * workTypeLibrary.test.cjs — cross-file consistency tests for the WorkType
 * union. Epic tag and PRD tag are one concept (WorkType); this test enforces
 * that every declaration site agrees, since the two module systems involved
 * (renderer .ts, main .cjs, and the preload .d.ts that can import neither)
 * can't enforce it via a shared import. Modelled on scheduleJobSchema.test.cjs's
 * JOB_STATUSES cross-file assertions.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/workTypeLibrary.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { WORK_TYPES, WorkTypeSchema } = require('../lib/workTypeLibrary.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TAG_LIBRARY_PATH = path.join(REPO_ROOT, 'src/renderer/lib/tagLibrary.ts');
const API_D_TS_PATH = path.join(REPO_ROOT, 'src/preload/api.d.ts');
const IPC_SCHEMAS_PATH = path.join(REPO_ROOT, 'src/main/ipcSchemas.cjs');

test('WORK_TYPES matches the expected 6 canonical ids in order', () => {
  expect(WORK_TYPES).toEqual([
    'feature',
    'bug',
    'discussion',
    'build',
    'project-home-builder',
    'bilko-host-publisher',
  ]);
});

test('WorkTypeSchema accepts every WORK_TYPES value and rejects an unknown one', () => {
  for (const value of WORK_TYPES) {
    expect(WorkTypeSchema.safeParse(value).success).toBe(true);
  }
  expect(WorkTypeSchema.safeParse('not-a-real-tag').success).toBe(false);
});

test('WORK_TYPES matches the tag ids declared in tagLibrary.ts TAG_LIBRARY, in order', () => {
  const src = fs.readFileSync(TAG_LIBRARY_PATH, 'utf8');
  const tagMatches = [...src.matchAll(/^\s*tag:\s*'([^']+)',/gm)].map((m) => m[1]);
  expect(tagMatches).toEqual(WORK_TYPES);
});

test('api.d.ts tag unions (line ~1166 and ~1687) both contain exactly the same 6 values', () => {
  const src = fs.readFileSync(API_D_TS_PATH, 'utf8');
  const unionMatches = [...src.matchAll(/tag\?:\s*((?:'[^']+'\s*\|?\s*)+);/g)].map((m) =>
    m[1]
      .split('|')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
  );

  expect(unionMatches.length).toBeGreaterThanOrEqual(2);
  for (const union of unionMatches) {
    expect(union).toEqual(WORK_TYPES);
  }
});

test('ipcSchemas.cjs no longer hardcodes the full-taxonomy tag z.enum literal', () => {
  const src = fs.readFileSync(IPC_SCHEMAS_PATH, 'utf8');
  // The old scheduleRetagPrd literal was missing 'bilko-host-publisher'
  // (5 of the 6 WORK_TYPES values) — assert that exact stale shape is gone.
  expect(src).not.toMatch(/z\.enum\(\['feature',\s*'bug',\s*'discussion',\s*'build',\s*'project-home-builder'\]\)/);
  expect(src).toMatch(/tag:\s*WorkTypeSchema/);
});
