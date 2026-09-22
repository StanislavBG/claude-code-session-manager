/**
 * check-renderer-storage.test.cjs — a bare localStorage/sessionStorage call in a scratch
 * src/renderer tree fails the lint; an allowlisted one passes.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/check-renderer-storage.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-renderer-storage.cjs');
const { scan } = require('../check-renderer-storage.cjs');

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = () => spawnSync('node', [SCRIPT, root], { encoding: 'utf8', timeout: 30000 });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-storage-lint-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('bare localStorage call in src/renderer fails with file:line', () => {
  write('src/renderer/lib/foo.ts', "const x = localStorage.getItem('a')\n");
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/renderer/lib/foo.ts:1');
});

test('bare sessionStorage call in src/renderer fails', () => {
  write('src/renderer/components/Bar.tsx', "sessionStorage.setItem('a', '1')\n");
  expect(run().status).toBe(1);
});

test('__tests__ files are skipped', () => {
  write('src/renderer/__tests__/foo.test.tsx', "localStorage.getItem('a')\n");
  expect(run().status).toBe(0);
});

test('comment-only mentions are not flagged', () => {
  write('src/renderer/lib/baz.ts', "// tour completion is purely localStorage.\nconst y = 1\n");
  expect(run().status).toBe(0);
});

test('allowlisted files pass', () => {
  write('src/renderer/lib/allowed.ts', "localStorage.getItem('a')\n");
  expect(scan(root, { allowlist: new Map([['src/renderer/lib/allowed.ts', 'test reason']]) })).toEqual([]);
});

test('clean tree exits 0', () => {
  write('src/renderer/lib/ok.ts', "const x = diskBackedStore.get('a')\n");
  expect(run().status).toBe(0);
});

test('the real repo tree is clean (current ALLOWLIST covers HEAD)', () => {
  expect(scan(path.resolve(__dirname, '../..'))).toEqual([]);
});
