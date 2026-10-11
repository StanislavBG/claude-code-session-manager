/**
 * check-e2e-budget.test.cjs — the e2e budget linter passes under/at the
 * ceiling and fails over it, using a scratch root.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/check-e2e-budget.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-e2e-budget.cjs');
const CEILING = Number(/E2E_SPEC_CEILING = (\d+)/.exec(fs.readFileSync(SCRIPT, 'utf8'))[1]);

let root;
const seed = (n) => {
  const dir = path.join(root, 'tests', 'e2e');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `s${i}.spec.${i % 2 ? 'mjs' : 'ts'}`), '');
  fs.writeFileSync(path.join(dir, 'helper.ts'), '');
};
const run = () => spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-budget-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('under the ceiling passes', () => {
  seed(CEILING - 1);
  expect(run().status).toBe(0);
});

test('at the ceiling passes', () => {
  seed(CEILING);
  expect(run().status).toBe(0);
});

test('over the ceiling fails with a one-line count/ceiling diagnostic', () => {
  seed(CEILING + 1);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr.trim().split('\n')).toHaveLength(1);
  expect(r.stderr).toContain(`${CEILING + 1} specs`);
  expect(r.stderr).toContain(`ceiling ${CEILING}`);
});
