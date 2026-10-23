/**
 * auditLog.test.cjs — readTail returns a bounded reverse tail of complete lines.
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/auditLog.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readTail, appendAuditEvent, settleRolls, MAX_LIVE_BYTES } = require('../auditLog.cjs');

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

function setMtime(f, iso) { const d = new Date(iso); fs.utimesSync(f, d, d); }

test('month rollover gzips old content and starts a fresh file', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'roll-'));
  const f = path.join(d, 'audit-log.jsonl');
  fs.writeFileSync(f, '{"old":1}\n');
  setMtime(f, '2026-09-20T00:00:00Z');
  appendAuditEvent('x', {}, { target: f, now: new Date('2026-10-02T00:00:00Z') });
  await settleRolls();
  const gz = path.join(d, 'audit-log-2026-09.jsonl.gz');
  expect(zlib.gunzipSync(fs.readFileSync(gz)).toString()).toBe('{"old":1}\n');
  const live = fs.readFileSync(f, 'utf8').trim().split('\n');
  expect(live).toHaveLength(1);
  expect(JSON.parse(live[0]).kind).toBe('x');
});

test('same month does not rotate', () => {
  const d = fs.mkdtempSync(path.join(dir, 'same-'));
  const f = path.join(d, 'audit-log.jsonl');
  fs.writeFileSync(f, '{"old":1}\n');
  setMtime(f, '2026-10-01T00:00:00Z');
  appendAuditEvent('x', {}, { target: f, now: new Date('2026-10-18T00:00:00Z') });
  expect(fs.readdirSync(d)).toEqual(['audit-log.jsonl']);
  expect(fs.readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('8 rolled files → newest 6 remain', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'prune-'));
  const f = path.join(d, 'audit-log.jsonl');
  for (let m = 1; m <= 8; m++) fs.writeFileSync(path.join(d, `audit-log-2026-0${m}.jsonl.gz`), 'x');
  fs.writeFileSync(f, '{"old":1}\n');
  setMtime(f, '2026-09-20T00:00:00Z');
  appendAuditEvent('x', {}, { target: f, now: new Date('2026-10-02T00:00:00Z') });
  await settleRolls();
  const rolled = fs.readdirSync(d).filter((n) => n.endsWith('.gz')).sort();
  expect(rolled).toEqual(['audit-log-2026-04.jsonl.gz', 'audit-log-2026-05.jsonl.gz', 'audit-log-2026-06.jsonl.gz',
    'audit-log-2026-07.jsonl.gz', 'audit-log-2026-08.jsonl.gz', 'audit-log-2026-09.jsonl.gz']);
});

test('append still lands when the roll gzip errors', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'err-'));
  const f = path.join(d, 'audit-log.jsonl');
  fs.writeFileSync(f, '{"old":1}\n');
  setMtime(f, '2026-09-20T00:00:00Z');
  fs.mkdirSync(path.join(d, 'audit-log-2026-09.jsonl.gz')); // roll target is a dir → write throws
  appendAuditEvent('x', {}, { target: f, now: new Date('2026-10-02T00:00:00Z') });
  await settleRolls();
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).kind).toBe('x');
});

test('roll streams into the month archive and the archive gunzips to the original lines', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'stream-'));
  const f = path.join(d, 'audit-log.jsonl');
  const gz = path.join(d, 'audit-log-2026-09.jsonl.gz');
  const first = Array.from({ length: 200 }, (_, i) => JSON.stringify({ n: i })).join('\n') + '\n';
  fs.writeFileSync(gz, zlib.gzipSync('{"prior":1}\n'));
  fs.writeFileSync(f, first);
  setMtime(f, '2026-09-20T00:00:00Z');
  appendAuditEvent('x', {}, { target: f, now: new Date('2026-10-02T00:00:00Z') });
  expect(fs.readdirSync(d).some((n) => n.includes('.rolling-'))).toBe(true); // rename was sync
  await settleRolls();
  expect(zlib.gunzipSync(fs.readFileSync(gz)).toString()).toBe('{"prior":1}\n' + first);
  expect(fs.readdirSync(d).sort()).toEqual(['audit-log-2026-09.jsonl.gz', 'audit-log.jsonl']);
});

test('size over 32 MB triggers a roll', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'size-'));
  const f = path.join(d, 'audit-log.jsonl');
  fs.writeFileSync(f, '{"big":1}\n');
  fs.truncateSync(f, MAX_LIVE_BYTES + 1); // sparse; NUL-padded
  setMtime(f, '2026-10-01T00:00:00Z');
  appendAuditEvent('x', {}, { target: f, now: new Date('2026-10-18T00:00:00Z') });
  await settleRolls();
  const gz = path.join(d, 'audit-log-2026-10.jsonl.gz');
  expect(zlib.gunzipSync(fs.readFileSync(gz)).length).toBe(MAX_LIVE_BYTES + 1);
  expect(fs.readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('failed roll keeps the renamed file for retry', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'retry-'));
  const f = path.join(d, 'audit-log.jsonl');
  const gz = path.join(d, 'audit-log-2026-09.jsonl.gz');
  fs.writeFileSync(f, '{"old":1}\n');
  setMtime(f, '2026-09-20T00:00:00Z');
  fs.mkdirSync(gz); // archive path is a dir → gzip fails
  appendAuditEvent('x', {}, { target: f, now: new Date('2026-10-02T00:00:00Z') });
  await settleRolls();
  const left = fs.readdirSync(d).filter((n) => n.includes('.rolling-'));
  expect(left).toHaveLength(1);
  expect(fs.readFileSync(path.join(d, left[0]), 'utf8')).toBe('{"old":1}\n');
  fs.rmdirSync(gz);
  fs.writeFileSync(f, '{"new":1}\n');
  setMtime(f, '2026-09-25T00:00:00Z');
  appendAuditEvent('y', {}, { target: f, now: new Date('2026-10-03T00:00:00Z') });
  await settleRolls();
  expect(zlib.gunzipSync(fs.readFileSync(gz)).toString()).toBe('{"old":1}\n{"new":1}\n');
  expect(fs.readdirSync(d).some((n) => n.includes('.rolling-'))).toBe(false);
});
