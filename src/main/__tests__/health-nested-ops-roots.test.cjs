/**
 * health-nested-ops-roots.test.cjs — findNestedOpsRoots(): read-only scan for
 * stray session-manager-operations dirs nested under a project root.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-nested-ops-roots.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findNestedOpsRoots } = require('../health.cjs');

const OPS = 'session-manager-operations';
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-ops-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const mk = (...parts) => fs.mkdirSync(path.join(root, ...parts), { recursive: true });

test('reports ops/ops and tests/ops, not the top-level root', () => {
  mk(OPS, OPS);
  mk('tests', OPS);
  mk('src');
  expect(findNestedOpsRoots(root, { maxDepth: 3 }).sort()).toEqual([
    path.join(root, OPS, OPS),
    path.join(root, 'tests', OPS),
  ].sort());
});

test('clean tree returns []', () => {
  mk(OPS, 'scheduler');
  mk('src', 'lib');
  expect(findNestedOpsRoots(root, { maxDepth: 3 })).toEqual([]);
});

test('ignores node_modules, .git and .claude/worktrees', () => {
  mk('node_modules', 'pkg', OPS);
  mk('.git', OPS);
  mk('.claude', 'worktrees', 'wt', OPS);
  expect(findNestedOpsRoots(root, { maxDepth: 3 })).toEqual([]);
});

test('respects maxDepth and never modifies the tree', () => {
  mk('a', 'b', 'c', OPS);
  expect(findNestedOpsRoots(root, { maxDepth: 3 })).toEqual([]);
  expect(findNestedOpsRoots(root, { maxDepth: 4 })).toEqual([path.join(root, 'a', 'b', 'c', OPS)]);
  expect(fs.existsSync(path.join(root, 'a', 'b', 'c', OPS))).toBe(true);
});
