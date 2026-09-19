/**
 * auditLog.test.cjs — readTail returns a bounded reverse tail of complete lines.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/auditLog.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTail } = require('../auditLog.cjs');

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditlog-tail-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('missing file → []', () => {
  expect(readTail(1024, path.join(dir, 'nope.jsonl'))).toEqual([]);
});

test('window larger than file → every line', () => {
  const f = path.join(dir, 'small.jsonl');
  fs.writeFileSync(f, '{"n":1}\n{"n":2}\n');
  expect(readTail(1_000_000, f)).toEqual(['{"n":1}', '{"n":2}']);
});

test('bounded window drops the partial leading line and keeps the newest', () => {
  const f = path.join(dir, 'big.jsonl');
  const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(50) }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const tail = readTail(500, f);
  expect(tail.length).toBeGreaterThan(0);
  expect(tail.length).toBeLessThan(20);
  expect(tail[tail.length - 1]).toBe(lines[999]);
  for (const l of tail) expect(() => JSON.parse(l)).not.toThrow();
  expect(readTail(0, f)).toEqual([]);
});
