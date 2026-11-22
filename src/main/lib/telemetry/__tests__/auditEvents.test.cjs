/**
 * auditEvents.test.cjs — readEventsAfter pages audit rows by cursor, across one rotated archive.
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/auditEvents.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readEventsAfter, OUTSIDE_EVENT_KINDS, INVALID_AUDIT_CURSOR, MAX_ARCHIVE_GZ_BYTES } = require('../auditEvents.cjs');

let root;
beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'auditevents-')); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const T = (s) => `2026-11-01T00:00:${String(s).padStart(2, '0')}.000Z`;
const row = (s, kind, extra = {}) => ({ at: T(s), kind, ...extra, caller: { pid: 1, ppid: 0, claudeSessionId: null } });
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

function logDir(rows, archiveRows) {
  const d = fs.mkdtempSync(path.join(root, 'd-'));
  const target = path.join(d, 'audit-log.jsonl');
  fs.writeFileSync(target, rows.length ? jsonl(rows) : '');
  if (archiveRows) {
    fs.writeFileSync(path.join(d, 'audit-log-2026-09.jsonl.gz'), zlib.gzipSync('{"at":"2026-09-01T00:00:00.000Z","kind":"epic_state_changed","n":"stale"}\n'));
    fs.writeFileSync(path.join(d, 'audit-log-2026-10.jsonl.gz'), zlib.gzipSync(jsonl(archiveRows)));
  }
  return target;
}

test('OUTSIDE_EVENT_KINDS', () => {
  expect([...OUTSIDE_EVENT_KINDS].sort()).toEqual(['epic_state_changed', 'job_transition']);
});

test('paging with limit, caller stripped, more + next', () => {
  const target = logDir([1, 2, 3, 4, 5].map((s) => row(s, 'epic_state_changed', { n: s })));
  const a = readEventsAfter({ after: 'start', limit: 2, target });
  expect(a.events.map((e) => e.n)).toEqual([1, 2]);
  expect(a.events[0].caller).toBeUndefined();
  expect(a.more).toBe(true);
  expect(a.gap).toBe(false);
  expect(a.next).toBe(`${T(2)}~1`);
  const b = readEventsAfter({ after: a.next, limit: 2, target });
  expect(b.events.map((e) => e.n)).toEqual([3, 4]);
  const c = readEventsAfter({ after: b.next, limit: 2, target });
  expect(c.events.map((e) => e.n)).toEqual([5]);
  expect(c.more).toBe(false);
  const d = readEventsAfter({ after: c.next, limit: 2, target });
  expect(d).toEqual({ events: [], next: c.next, more: false, gap: false });
});

test('limit defaults to 100 and caps at 500', () => {
  const target = logDir(Array.from({ length: 600 }, (_, i) => row(1, 'epic_state_changed', { n: i })));
  expect(readEventsAfter({ after: 'start', target }).events).toHaveLength(100);
  const big = readEventsAfter({ after: 'start', limit: 10_000, target });
  expect(big.events).toHaveLength(500);
  expect(big.more).toBe(true);
});

test('rows sharing one timestamp are never skipped or repeated', () => {
  const rows = [row(1, 'epic_state_changed', { n: 0 })];
  for (let i = 1; i <= 5; i++) rows.push(row(2, 'epic_state_changed', { n: i }));
  rows.push(row(3, 'epic_state_changed', { n: 6 }));
  const target = logDir(rows);
  const seen = [];
  let after = 'start';
  for (let i = 0; i < 10; i++) {
    const r = readEventsAfter({ after, limit: 2, target });
    seen.push(...r.events.map((e) => e.n));
    after = r.next;
    if (!r.more) break;
  }
  expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(after).toBe(`${T(3)}~1`);
});

test('kinds filter; default is epic_state_changed; next passes non-matching rows', () => {
  const target = logDir([
    row(1, 'epic_state_changed', { n: 1 }),
    row(2, 'job_transition', { n: 2 }),
    row(3, 'prd_create', { n: 3 }),
    row(4, 'job_transition', { n: 4 }),
  ]);
  expect(readEventsAfter({ after: 'start', target }).events.map((e) => e.n)).toEqual([1]);
  const r = readEventsAfter({ after: 'start', target });
  expect(r.next).toBe(`${T(4)}~1`);
  expect(r.more).toBe(false);
  const both = readEventsAfter({ after: 'start', kinds: OUTSIDE_EVENT_KINDS, target });
  expect(both.events.map((e) => e.n)).toEqual([1, 2, 4]);
  const none = readEventsAfter({ after: `${T(1)}~1`, target });
  expect(none.events).toEqual([]);
  expect(none.next).toBe(`${T(4)}~1`);
});

test('after absent → no events, next at the newest live row', () => {
  const target = logDir([row(1, 'epic_state_changed'), row(2, 'epic_state_changed'), row(2, 'job_transition')]);
  const r = readEventsAfter({ target });
  expect(r).toEqual({ events: [], next: `${T(2)}~2`, more: false, gap: false });
  fs.appendFileSync(target, jsonl([row(3, 'epic_state_changed', { n: 'new' })]));
  expect(readEventsAfter({ after: r.next, target }).events.map((e) => e.n)).toEqual(['new']);
});

test('after absent on an empty or missing log → next is start', () => {
  const target = logDir([]);
  expect(readEventsAfter({ target })).toEqual({ events: [], next: 'start', more: false, gap: false });
  const missing = path.join(root, 'none', 'audit-log.jsonl');
  expect(readEventsAfter({ target: missing })).toEqual({ events: [], next: 'start', more: false, gap: false });
});

test('malformed cursor throws naming the expected form', () => {
  const target = logDir([row(1, 'epic_state_changed')]);
  for (const bad of ['garbage', '2026-11-01T00:00:01.000Z', `${T(1)}~x`, `${T(1)}~-1`, 42]) {
    expect(() => readEventsAfter({ after: bad, target })).toThrow(/<ISO timestamp>~<count>/);
  }
});

test('malformed cursor error carries code INVALID_AUDIT_CURSOR, message unchanged', () => {
  expect(INVALID_AUDIT_CURSOR).toBe('INVALID_AUDIT_CURSOR');
  const target = logDir([row(1, 'epic_state_changed')]);
  let err;
  try { readEventsAfter({ after: 'garbage', target }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(Error);
  expect(err.code).toBe(INVALID_AUDIT_CURSOR);
  expect(err.message).toMatch(/^invalid audit cursor "garbage": expected '<ISO timestamp>~<count>'/);
});

test('a malformed line is skipped', () => {
  const target = logDir([row(1, 'epic_state_changed', { n: 1 }), '{not json', '"just a string"', row(2, 'epic_state_changed', { n: 2 })]);
  const r = readEventsAfter({ after: 'start', target });
  expect(r.events.map((e) => e.n)).toEqual([1, 2]);
  expect(r.next).toBe(`${T(2)}~1`);
});

test('growing window finds the cursor deep in a large live file', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => row(Math.floor(i / 40), 'epic_state_changed', { n: i, pad: 'x'.repeat(40) }));
  const target = logDir(rows);
  const r = readEventsAfter({ after: `${T(0)}~3`, limit: 5, target, initialWindow: 256 });
  expect(r.events.map((e) => e.n)).toEqual([3, 4, 5, 6, 7]);
  expect(r.gap).toBe(false);
  const tail = readEventsAfter({ after: `${T(49)}~38`, target, initialWindow: 256 });
  expect(tail.events.map((e) => e.n)).toEqual([1998, 1999]);
});

test('cursor older than the live file reads the newest rotated archive first', () => {
  const target = logDir(
    [row(10, 'epic_state_changed', { n: 'live1' }), row(11, 'epic_state_changed', { n: 'live2' })],
    [row(1, 'epic_state_changed', { n: 'a1' }), row(2, 'epic_state_changed', { n: 'a2' }), row(3, 'job_transition', { n: 'a3' })],
  );
  const r = readEventsAfter({ after: `${T(1)}~1`, target });
  expect(r.events.map((e) => e.n)).toEqual(['a2', 'live1', 'live2']);
  expect(r.gap).toBe(false);
  const paged = readEventsAfter({ after: `${T(1)}~1`, limit: 1, target });
  expect(paged.events.map((e) => e.n)).toEqual(['a2']);
  expect(paged.more).toBe(true);
  const rest = readEventsAfter({ after: paged.next, target });
  expect(rest.events.map((e) => e.n)).toEqual(['live1', 'live2']);
  expect(rest.gap).toBe(false);
});

test('gap is true when the cursor predates the archive too', () => {
  const target = logDir(
    [row(10, 'epic_state_changed', { n: 'live1' })],
    [row(5, 'epic_state_changed', { n: 'a1' })],
  );
  const r = readEventsAfter({ after: '2026-10-15T00:00:00.000Z~0', target });
  expect(r.gap).toBe(true);
  expect(r.events.map((e) => e.n)).toEqual(['a1', 'live1']);
  expect(r.next).toBe(`${T(10)}~1`);
  const noArchive = logDir([row(10, 'epic_state_changed', { n: 'live1' })]);
  expect(readEventsAfter({ after: `${T(1)}~1`, target: noArchive }).gap).toBe(true);
});

test('two rows sharing one at across the rotation boundary are each returned exactly once', () => {
  const target = logDir(
    [row(5, 'epic_state_changed', { n: 'live-first' }), row(6, 'epic_state_changed', { n: 'live2' })],
    [row(1, 'epic_state_changed', { n: 'a1' }), row(5, 'epic_state_changed', { n: 'archive-last' })],
  );
  const first = readEventsAfter({ after: `${T(1)}~1`, limit: 1, target });
  expect(first.events.map((e) => e.n)).toEqual(['archive-last']);
  expect(first.more).toBe(true);
  expect(first.gap).toBe(false);
  const second = readEventsAfter({ after: first.next, limit: 1, target });
  expect(second.events.map((e) => e.n)).toEqual(['live-first']);
  expect(second.gap).toBe(false);
  const third = readEventsAfter({ after: second.next, target });
  expect(third.events.map((e) => e.n)).toEqual(['live2']);
});

test('MAX_ARCHIVE_GZ_BYTES is 16 MB', () => {
  expect(MAX_ARCHIVE_GZ_BYTES).toBe(16 * 1024 * 1024);
});

test('an archive over maxArchiveGzBytes is skipped: gap true, live rows only', () => {
  const target = logDir(
    [row(10, 'epic_state_changed', { n: 'live1' }), row(11, 'epic_state_changed', { n: 'live2' })],
    [row(1, 'epic_state_changed', { n: 'a1' }), row(2, 'epic_state_changed', { n: 'a2' })],
  );
  const r = readEventsAfter({ after: `${T(1)}~1`, target, maxArchiveGzBytes: 8 });
  expect(r.gap).toBe(true);
  expect(r.events.map((e) => e.n)).toEqual(['live1', 'live2']);
  expect(r.next).toBe(`${T(11)}~1`);
});

test('an archive under maxArchiveGzBytes is read as before', () => {
  const target = logDir(
    [row(10, 'epic_state_changed', { n: 'live1' })],
    [row(1, 'epic_state_changed', { n: 'a1' }), row(2, 'epic_state_changed', { n: 'a2' })],
  );
  const r = readEventsAfter({ after: `${T(1)}~1`, target, maxArchiveGzBytes: 1024 * 1024 });
  expect(r.gap).toBe(false);
  expect(r.events.map((e) => e.n)).toEqual(['a2', 'live1']);
});
