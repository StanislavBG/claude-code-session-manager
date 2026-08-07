/**
 * config-readText-bounded.test.cjs — readText's optional { maxBytes } bounded
 * prefix read. Regression coverage for perf-known-projects-bounded-cwd-read:
 * resolveProjectCwd used to read whole (sometimes multi-MB) transcript files
 * just to find the first line containing "cwd".
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/config-readText-bounded.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmpFile(name, content) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-readtext-'));
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  const abs = path.join(dir, name);
  await fsp.writeFile(abs, content, 'utf8');
  return abs;
}

test('bounded read returns only the requested prefix and sets truncated', async () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `{"line":${i},"pad":"${'x'.repeat(50)}"}`).join('\n') + '\n';
  const abs = await mkTmpFile('big.jsonl', lines);
  const full = await config.readText(abs);
  expect(full.truncated).toBe(false);

  const bounded = await config.readText(abs, { maxBytes: 1024 });
  expect(bounded.exists).toBe(true);
  expect(bounded.truncated).toBe(true);
  expect(bounded.text.length).toBeLessThan(full.text.length);
  expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(1024);
  // every line handed back must be a complete, parseable JSON line — no
  // partial trailing fragment from the byte cut.
  const returnedLines = bounded.text.split('\n').filter(Boolean);
  for (const line of returnedLines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
});

test('unbounded read (no opts) is byte-identical to before', async () => {
  const content = 'line one\nline two\nline three\n';
  const abs = await mkTmpFile('plain.txt', content);
  const r = await config.readText(abs);
  expect(r.exists).toBe(true);
  expect(r.text).toBe(content);
  expect(r.truncated).toBe(false);
  expect(typeof r.mtimeMs).toBe('number');
  expect(r.error).toBe(null);
});

test('maxBytes larger than the file returns the whole file with truncated=false', async () => {
  const content = 'short file\ncontent here\n';
  const abs = await mkTmpFile('small.txt', content);
  const r = await config.readText(abs, { maxBytes: 1024 * 1024 });
  expect(r.exists).toBe(true);
  expect(r.text).toBe(content);
  expect(r.truncated).toBe(false);
});

test('bounded read on a missing file behaves like the unbounded case', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-readtext-missing-'));
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  const abs = path.join(dir, 'nope.txt');
  const r = await config.readText(abs, { maxBytes: 1024 });
  expect(r.exists).toBe(false);
  expect(r.text).toBe('');
  expect(r.truncated).toBe(false);
  expect(r.error).toBe(null);
});
