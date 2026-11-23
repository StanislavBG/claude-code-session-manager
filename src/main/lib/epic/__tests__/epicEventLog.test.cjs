/**
 * epicEventLog.test.cjs — the per-Epic durable event log (lib/epic/epicEventLog.cjs).
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/epicEventLog.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../epicEventLog.cjs');
const { opsPath, checkOpsWrite } = require('../../opsOwnership.cjs');

const EPIC = 'epic-abc123';
let cwd;
let home;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-events-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-events-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  log._resetForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const file = () => opsPath(cwd, 'events', EPIC, 'events.jsonl');

test('EVENT_KINDS is the closed {domain}.{action} set', () => {
  expect([...log.EVENT_KINDS].sort()).toEqual([
    'epic.minted', 'epic.status_changed', 'job.queued', 'job.status_changed', 'job.tool_use',
    'job.needs_input', 'job.confirmation_requested', 'human.message', 'human.answer',
    'human.interrupt', 'human.tool_confirmation', 'validator.verdict', 'outcome.recorded',
  ].sort());
  expect(Object.isFrozen(log.EVENT_KINDS)).toBe(true);
});

test('appends to events/<epicId>/events.jsonl with monotonic seq + ISO time; replays by cursor', async () => {
  const a = await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted', summary: 'born' });
  const b = await log.appendEpicEvent(cwd, EPIC, { kind: 'job.queued', prdId: 3779 });
  const c = await log.appendEpicEvent(cwd, EPIC, { kind: 'human.message', summary: 'hi' });
  expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  expect(new Date(a.time).toISOString()).toBe(a.time);
  expect(a.epicId).toBe(EPIC);

  const lines = fs.readFileSync(file(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => l.kind)).toEqual(['epic.minted', 'job.queued', 'human.message']);

  const first = await log.readEpicEvents(cwd, EPIC, { limit: 2 });
  expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
  expect(first.cursor).toBe(2);
  expect(first.hasMore).toBe(true);

  const rest = await log.readEpicEvents(cwd, EPIC, { after: first.cursor, limit: 2 });
  expect(rest.events.map((e) => e.seq)).toEqual([3]);
  expect(rest.cursor).toBe(3);
  expect(rest.hasMore).toBe(false);

  const none = await log.readEpicEvents(cwd, EPIC, { after: 3 });
  expect(none).toEqual({ events: [], cursor: 3, hasMore: false });
});

test('seq continues from the file after an in-memory reset', async () => {
  await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted' });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'job.queued' });
  log._resetForTests();
  const e = await log.appendEpicEvent(cwd, EPIC, { kind: 'job.status_changed', status: 'running' });
  expect(e.seq).toBe(3);
});

test('kind filter', async () => {
  await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted' });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'job.queued' });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'human.answer' });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'job.queued' });
  const r = await log.readEpicEvents(cwd, EPIC, { kinds: ['job.queued'], limit: 1 });
  expect(r.events.map((e) => e.seq)).toEqual([2]);
  expect(r.hasMore).toBe(true);
  const r2 = await log.readEpicEvents(cwd, EPIC, { kinds: ['job.queued'], after: r.cursor });
  expect(r2.events.map((e) => e.seq)).toEqual([4]);
  expect(r2.hasMore).toBe(false);
});

test('unknown kind, bad epicId and unknown filter kind are refused', async () => {
  await expect(log.appendEpicEvent(cwd, EPIC, { kind: 'job.exploded' })).rejects.toThrow(/unknown event kind/);
  await expect(log.appendEpicEvent(cwd, EPIC, {})).rejects.toThrow(/unknown event kind/);
  await expect(log.appendEpicEvent(cwd, '../escape', { kind: 'epic.minted' })).rejects.toThrow(/invalid epicId/);
  await expect(log.appendEpicEvent(cwd, '', { kind: 'epic.minted' })).rejects.toThrow(/invalid epicId/);
  await expect(log.readEpicEvents(cwd, 'a/b')).rejects.toThrow(/invalid epicId/);
  await expect(log.readEpicEvents(cwd, EPIC, { kinds: ['nope.nope'] })).rejects.toThrow(/unknown event kind/);
  expect(fs.existsSync(file())).toBe(false);
});

test('string fields are capped at 2,000 chars, nested too; seq/time cannot be forged', async () => {
  const big = 'x'.repeat(5000);
  const e = await log.appendEpicEvent(cwd, EPIC, {
    kind: 'job.tool_use', summary: big, detail: { input: big, list: [big] }, seq: 999, time: 'yesterday',
  });
  expect(e.seq).toBe(1);
  expect(e.time).not.toBe('yesterday');
  const [line] = (await log.readEpicEvents(cwd, EPIC)).events;
  expect(line.summary.length).toBeLessThanOrEqual(2000);
  expect(line.detail.input.length).toBeLessThanOrEqual(2000);
  expect(line.detail.list[0].length).toBeLessThanOrEqual(2000);
  const walk = (v) => {
    if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(log.MAX_FIELD_CHARS);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(line);
});

test('concurrent appends keep seq unique and contiguous', async () => {
  const kinds = [...log.EVENT_KINDS];
  const out = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    log.appendEpicEvent(cwd, EPIC, { kind: kinds[i % kinds.length], i })));
  const seqs = out.map((e) => e.seq).sort((x, y) => x - y);
  expect(seqs).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  const read = await log.readEpicEvents(cwd, EPIC, { limit: 1000 });
  expect(new Set(read.events.map((e) => e.seq)).size).toBe(60);
});

test('a torn last line is tolerated on read and does not corrupt the next append', async () => {
  await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted' });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'job.queued' });
  fs.appendFileSync(file(), '{"seq":3,"kind":"job.qu');
  const r = await log.readEpicEvents(cwd, EPIC);
  expect(r.events.map((e) => e.seq)).toEqual([1, 2]);
  expect(r.hasMore).toBe(false);

  log._resetForTests();
  const next = await log.appendEpicEvent(cwd, EPIC, { kind: 'human.interrupt' });
  expect(next.seq).toBe(3);
  const r2 = await log.readEpicEvents(cwd, EPIC);
  expect(r2.events.map((e) => [e.seq, e.kind])).toEqual([[1, 'epic.minted'], [2, 'job.queued'], [3, 'human.interrupt']]);
});

test('missing log reads empty', async () => {
  expect(await log.readEpicEvents(cwd, EPIC)).toEqual({ events: [], cursor: 0, hasMore: false });
});

test("events/ is owned by 'event-log' alone", () => {
  expect(checkOpsWrite(file(), 'event-log').ok).toBe(true);
  expect(checkOpsWrite(file(), 'scheduler').ok).toBe(false);
});
