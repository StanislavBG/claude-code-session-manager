/**
 * check-ops-path-literals.test.cjs — a bare ops-root literal in a scratch tree fails the
 * lint; an allowlisted one passes.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/check-ops-path-literals.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-ops-path-literals.cjs');
const { scan } = require('../check-ops-path-literals.cjs');
const BARE = "const p = path.join(cwd, 'session-manager-operations', 'x');\n";

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = () => spawnSync('node', [SCRIPT, root], { encoding: 'utf8', timeout: 30000 });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-path-lint-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('bare join in src/main fails with file:line', () => {
  write('src/main/foo.cjs', `// c\n${BARE}`);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/main/foo.cjs:2');
});

test('bare join in scripts/ fails', () => {
  write('scripts/bar.cjs', BARE);
  expect(run().status).toBe(1);
});

test('resolver, __tests__, and allowlisted files pass', () => {
  write('src/main/lib/opsOwnership.cjs', BARE);
  write('src/main/__tests__/t.test.cjs', BARE);
  write('scripts/allowed.cjs', BARE);
  expect(scan(root, { allowlist: new Map([['scripts/allowed.cjs', 'test reason']]) })).toEqual([]);
});

test('clean tree exits 0', () => {
  write('src/main/ok.cjs', "const x = opsPath(cwd, 'a');\n");
  expect(run().status).toBe(0);
});

test('the real repo tree is clean', () => {
  expect(scan(path.resolve(__dirname, '../..'))).toEqual([]);
});
