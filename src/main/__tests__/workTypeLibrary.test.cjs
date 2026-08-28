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
const SCHEDULER_MCP_SERVER_PATH = path.join(REPO_ROOT, 'scripts/scheduler-mcp-server.cjs');

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
  // Epic tag (schedulerCreateEpic-style routes) draws on the full 6-value
  // WorkType union via EpicTagSchema, which is itself WorkTypeSchema
  // (promptSessionSchema.cjs). PRD tag fields (schedulerCreatePrd,
  // adminPrdFrontmatterPatch) draw on the narrower 5-value PrdWorkTypeSchema
  // — independent values, same shared vocabulary (PRD 1041).
  expect(src).toMatch(/tag:\s*EpicTagSchema/);
  const prdTagMatches = [...src.matchAll(/tag:\s*PrdWorkTypeSchema/g)];
  expect(prdTagMatches.length).toBeGreaterThanOrEqual(2);
});

test('scheduler-mcp-server.cjs requires PRD_WORK_TYPES rather than hardcoding a tag enum literal, and imports it exactly twice (scheduler_create_prd + scheduler_update_prd)', () => {
  const { PRD_WORK_TYPES } = require('../lib/workTypeLibrary.cjs');
  const src = fs.readFileSync(SCHEDULER_MCP_SERVER_PATH, 'utf8');
  expect(src).toMatch(/require\(['"].*workTypeLibrary\.cjs['"]\)/);
  const occurrences = [...src.matchAll(/enum:\s*PRD_WORK_TYPES/g)].length;
  // scheduler_create_prd's inputSchema.tag.enum and scheduler_update_prd's
  // frontmatter.tag.enum — exactly 2 sites, not the Epic-tag (6-value)
  // enum on feedback_open_session's tag property.
  expect(occurrences).toBe(2);
  expect(PRD_WORK_TYPES).toEqual(['feature', 'bug', 'build', 'project-home-builder', 'bilko-host-publisher']);
});
