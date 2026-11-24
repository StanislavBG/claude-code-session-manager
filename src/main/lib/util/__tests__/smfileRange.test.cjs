/**
 * smfileRange.test.cjs — Range-request (206) streaming for smfile:// media.
 *
 * Run: timeout 120 npx vitest run src/main/lib/util/__tests__/smfileRange.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRange, buildMediaResponse } = require('../smfileRange.cjs');

let dir;
let file;
const BYTES = Buffer.from('0123456789abcdefghij'); // 20 bytes

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smfile-range-'));
  file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, BYTES);
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function respond(range) {
  const st = fs.statSync(file);
  return buildMediaResponse(file, st, range, 'video/mp4');
}

test('parseRange: absent header → null (full body)', () => {
  expect(parseRange(undefined, 20)).toBeNull();
  expect(parseRange(null, 20)).toBeNull();
  expect(parseRange('', 20)).toBeNull();
});

test('parseRange: open-ended, closed, suffix, clamped', () => {
  expect(parseRange('bytes=0-', 20)).toEqual({ start: 0, end: 19 });
  expect(parseRange('bytes=5-', 20)).toEqual({ start: 5, end: 19 });
  expect(parseRange('bytes=2-6', 20)).toEqual({ start: 2, end: 6 });
  expect(parseRange('bytes=10-999', 20)).toEqual({ start: 10, end: 19 });
  expect(parseRange('bytes=-4', 20)).toEqual({ start: 16, end: 19 });
  expect(parseRange('bytes=-50', 20)).toEqual({ start: 0, end: 19 });
});

test('parseRange: unsatisfiable ranges', () => {
  expect(parseRange('bytes=20-', 20)).toEqual({ unsatisfiable: true });
  expect(parseRange('bytes=25-30', 20)).toEqual({ unsatisfiable: true });
  expect(parseRange('bytes=-0', 20)).toEqual({ unsatisfiable: true });
  expect(parseRange('bytes=0-', 0)).toEqual({ unsatisfiable: true });
});

test('parseRange: malformed headers are ignored (null → full body)', () => {
  for (const h of ['bytes', 'bytes=', 'bytes=-', 'bytes=abc', 'bytes=5-2', 'items=0-5',
    'bytes=0-1,4-5', 'bytes=1.5-3', ' bytes=0-1x']) {
    expect(parseRange(h, 20), h).toBeNull();
  }
});

test('buildMediaResponse: no range → 200 full body with Accept-Ranges', async () => {
  const res = await respond(null);
  expect(res.status).toBe(200);
  expect(res.headers.get('accept-ranges')).toBe('bytes');
  expect(res.headers.get('content-length')).toBe('20');
  expect(res.headers.get('content-type')).toBe('video/mp4');
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(BYTES.toString());
});

test('buildMediaResponse: bytes=0- → 206 whole file', async () => {
  const res = await respond('bytes=0-');
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe('bytes 0-19/20');
  expect(res.headers.get('content-length')).toBe('20');
  expect(res.headers.get('accept-ranges')).toBe('bytes');
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(BYTES.toString());
});

test('buildMediaResponse: bytes=a-b → 206 slice', async () => {
  const res = await respond('bytes=2-6');
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe('bytes 2-6/20');
  expect(res.headers.get('content-length')).toBe('5');
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('23456');
});

test('buildMediaResponse: suffix bytes=-n → 206 tail', async () => {
  const res = await respond('bytes=-3');
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe('bytes 17-19/20');
  expect(res.headers.get('content-length')).toBe('3');
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('hij');
});

test('buildMediaResponse: unsatisfiable → 416 with Content-Range bytes */size', async () => {
  const res = await respond('bytes=40-50');
  expect(res.status).toBe(416);
  expect(res.headers.get('content-range')).toBe('bytes */20');
  expect(res.headers.get('accept-ranges')).toBe('bytes');
});

test('buildMediaResponse: malformed range → 200 full body', async () => {
  const res = await respond('bytes=nope');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-length')).toBe('20');
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(BYTES.toString());
});
