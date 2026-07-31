/**
 * importReferences.spec.cjs — unit tests for listReferencedFiles, the IPC-facing
 * wrapper around personaImportHealth's `@path` import-chain walker.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/importReferences.spec.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listReferencedFiles } = require('../importReferences.cjs');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'import-refs-test-'));
}

test('listReferencedFiles: 2 valid @imports returns 2 entries with correct sizeBytes/tokenEstimate/ok', () => {
  const dir = mkTmpDir();
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');
  const root = path.join(dir, 'root.md');
  fs.writeFileSync(a, 'x'.repeat(40));
  fs.writeFileSync(b, 'y'.repeat(8));
  fs.writeFileSync(root, `@${a}\n@${b}\n`);

  const result = listReferencedFiles(root);

  expect(result).toHaveLength(2);
  const byPath = Object.fromEntries(result.map((r) => [r.path, r]));
  expect(byPath[a]).toEqual({ path: a, exists: true, sizeBytes: 40, tokenEstimate: 10, ok: true });
  expect(byPath[b]).toEqual({ path: b, exists: true, sizeBytes: 8, tokenEstimate: 2, ok: true });
});

test('listReferencedFiles: missing import returns ok=false with sizeBytes 0', () => {
  const dir = mkTmpDir();
  const missing = path.join(dir, 'does-not-exist.md');
  const root = path.join(dir, 'root.md');
  fs.writeFileSync(root, `@${missing}\n`);

  const result = listReferencedFiles(root);

  expect(result).toEqual([
    { path: missing, exists: false, sizeBytes: 0, tokenEstimate: 0, ok: false },
  ]);
});

test('listReferencedFiles: zero @import lines returns an empty array', () => {
  const dir = mkTmpDir();
  const root = path.join(dir, 'root.md');
  fs.writeFileSync(root, 'no imports here, just prose.\n');

  expect(listReferencedFiles(root)).toEqual([]);
});
