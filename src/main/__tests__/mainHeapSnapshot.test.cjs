/**
 * Run: timeout 120 npx vitest run src/main/__tests__/mainHeapSnapshot.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maybeCaptureMainHeap } = require('../lib/telemetry/mainHeapSnapshot.cjs');

let dir; let writes; let saved;
const roomy = () => ({ bavail: 1e9, bsize: 4096 });
const writeFn = (p) => { writes.push(p); fs.writeFileSync(p, 'x'); };
const call = (o) => maybeCaptureMainHeap({ dir, writeFn, statfsFn: roomy, thresholdMb: 1800, ...o });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-'));
  writes = [];
  saved = { a: process.env.SM_MAIN_HEAP_SNAPSHOT, b: process.env.SM_MAIN_HEAP_SNAPSHOT_MB };
  delete process.env.SM_MAIN_HEAP_SNAPSHOT; delete process.env.SM_MAIN_HEAP_SNAPSHOT_MB;
});
afterEach(() => {
  for (const [k, v] of [['SM_MAIN_HEAP_SNAPSHOT', saved.a], ['SM_MAIN_HEAP_SNAPSHOT_MB', saved.b]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('below threshold -> no write', () => {
  const r = call({ heapUsedMb: 1000, state: { captured: false } });
  expect(r.captured).toBe(false);
  expect(writes).toHaveLength(0);
});

test('at threshold -> one write; second crossing -> none', () => {
  const state = { captured: false };
  const r = call({ heapUsedMb: 1800, state });
  expect(r.captured).toBe(true);
  expect(path.basename(r.filePath)).toMatch(/^main-heap-.*\.heapsnapshot$/);
  const r2 = call({ heapUsedMb: 3000, state });
  expect(r2.captured).toBe(false);
  expect(writes).toHaveLength(1);
});

test('env disable', () => {
  process.env.SM_MAIN_HEAP_SNAPSHOT = '0';
  const r = call({ heapUsedMb: 5000, state: { captured: false } });
  expect(r).toMatchObject({ captured: false, reason: 'disabled' });
  expect(writes).toHaveLength(0);
});

test('env threshold override', () => {
  process.env.SM_MAIN_HEAP_SNAPSHOT_MB = '100';
  const r = maybeCaptureMainHeap({ heapUsedMb: 150, dir, writeFn, statfsFn: roomy, state: { captured: false } });
  expect(r.captured).toBe(true);
});

test('pruning keeps 2', () => {
  for (const t of ['2026-01-01', '2026-01-02', '2026-01-03']) fs.writeFileSync(path.join(dir, `main-heap-${t}.heapsnapshot`), 'x');
  fs.writeFileSync(path.join(dir, 'heap-other.heapsnapshot'), 'x');
  const r = call({ heapUsedMb: 2000, state: { captured: false }, now: new Date('2026-02-01T00:00:00Z') });
  expect(r.captured).toBe(true);
  const left = fs.readdirSync(dir).filter((n) => n.startsWith('main-heap-')).sort();
  expect(left).toHaveLength(2);
  expect(left[0]).toBe('main-heap-2026-01-03.heapsnapshot');
  expect(fs.existsSync(path.join(dir, 'heap-other.heapsnapshot'))).toBe(true);
});

test('low-disk refusal', () => {
  const r = call({ heapUsedMb: 2000, state: { captured: false }, statfsFn: () => ({ bavail: 1000, bsize: 1048576 }) });
  expect(r).toMatchObject({ captured: false, reason: 'low-disk' });
  expect(writes).toHaveLength(0);
});
