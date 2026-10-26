/**
 * promptSessionsMergeToMain carriedPaths bound — the list is the uncapped
 * carried diff (3,306 paths seen 2026-10-26).
 */

'use strict';

import { test, expect } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');
const schema = schemas.promptSessionsMergeToMain;

const base = {
  cwd: '/tmp/proj',
  epicId: 'abc123',
  branch: 'sm-epic/abc123',
  dir: '/tmp/wt',
};

test('accepts 5,000 carriedPaths', () => {
  const carriedPaths = Array.from({ length: 5000 }, (_, i) => `src/f${i}.ts`);
  expect(schema.safeParse({ ...base, carriedPaths }).success).toBe(true);
});

test('accepts no carriedPaths', () => {
  expect(schema.safeParse(base).success).toBe(true);
});

test('rejects empty-string path', () => {
  expect(schema.safeParse({ ...base, carriedPaths: [''] }).success).toBe(false);
});

test('rejects non sm-epic branch', () => {
  expect(schema.safeParse({ ...base, branch: 'main' }).success).toBe(false);
});
