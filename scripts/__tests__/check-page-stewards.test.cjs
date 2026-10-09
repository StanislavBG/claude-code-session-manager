/**
 * check-page-stewards.test.cjs — every listed page needs a well-formed steward persona;
 * PENDING only excuses absence; orphan page-*.md files are violations.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/check-page-stewards.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan, PENDING } = require('../check-page-stewards.cjs');

let root;
const pages = [{ key: 'alpha', label: 'Alpha', faces: ['home'], entry: 'x' }];
const persona = (over = {}) => {
  const fm = { name: 'page-alpha', description: 'Steward for Alpha', tools: 'Read, Grep', model: 'sonnet', ...over };
  const lines = Object.entries(fm).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\nSee session-manager-operations/architecture/page-stewards.md and run node scripts/page-surface.cjs alpha\n`;
};
const write = (name, text) => {
  fs.mkdirSync(path.join(root, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/agents', name), text);
};
const run = () => scan(root, { pages, pending: new Map() });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-stewards-lint-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('valid persona has zero violations', () => {
  write('page-alpha.md', persona());
  expect(run()).toEqual([]);
});

test('wrong name is one violation', () => {
  write('page-alpha.md', persona({ name: 'page-beta' }));
  expect(run()).toHaveLength(1);
});

test('missing model is one violation', () => {
  write('page-alpha.md', persona({ model: null }));
  expect(run()).toHaveLength(1);
});

test('model: inherit is one violation', () => {
  write('page-alpha.md', persona({ model: 'inherit' }));
  expect(run()).toHaveLength(1);
});

test('missing charter path is one violation', () => {
  write('page-alpha.md', persona().replace('session-manager-operations/architecture/page-stewards.md', 'nothing'));
  expect(run()).toHaveLength(1);
});

test('orphan persona file is one violation', () => {
  write('page-alpha.md', persona());
  write('page-ghost.md', persona({ name: 'page-ghost' }));
  expect(run()).toHaveLength(1);
});

test('missing persona not in PENDING is one violation; PENDING excuses it', () => {
  expect(run()).toHaveLength(1);
  expect(scan(root, { pages, pending: new Map([['alpha', 'r']]) })).toEqual([]);
});

test('PENDING holds the 18 nav keys', () => {
  expect(PENDING.size).toBe(18);
});
