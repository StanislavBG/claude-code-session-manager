/**
 * needsYouIpc.test.cjs — the Dashboard's needsYou:list / needsYou:answer IPC
 * over needsYouStore.cjs, with a fake ipcMain and a temp SM_SCHEDULER_HOME.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/needsYouIpc.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp;
let prevHome;
let store;
let handlers;
let onChanged;

function fakeIpcMain() {
  const map = new Map();
  return { map, handle: (channel, fn) => map.set(channel, fn) };
}

const invoke = (channel, payload) => handlers.get(channel)({}, payload);

function auditRows() {
  const p = path.join(tmp, 'audit-log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-you-ipc-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = tmp;
  store = require('../lib/feedback-remote/needsYouStore.cjs');
  const { registerNeedsYouIpc } = require('../lib/feedback-remote/needsYouIpc.cjs');
  const ipcMain = fakeIpcMain();
  onChanged = vi.fn();
  registerNeedsYouIpc({ ipcMain, onChanged });
  handlers = ipcMain.map;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (over = {}) => store.postNeedsYou({
  app: 'portfolio', id: 'q-1', title: 'Pick a plan', options: ['yes', 'no'], ...over,
});

test('registers all three channels', () => {
  expect([...handlers.keys()].sort()).toEqual(['needsYou:answer', 'needsYou:list', 'scheduler:confirm-tool']);
});

test('needsYou:list returns only the open items', async () => {
  await post();
  await post({ id: 'q-2' });
  await post({ id: 'q-3' });
  await store.withdrawNeedsYou({ app: 'portfolio', id: 'q-3' });
  const res = await invoke('needsYou:list', undefined);
  expect(res.ok).toBe(true);
  expect(res.items.map((i) => i.id).sort()).toEqual(['q-1', 'q-2']);
  expect(res.items.every((i) => i.status === 'open')).toBe(true);
  // an empty object payload is accepted too
  expect((await invoke('needsYou:list', {})).items).toHaveLength(2);
});

test('needsYou:list rejects an unexpected payload', () => {
  expect(() => invoke('needsYou:list', { status: 'answered' })).toThrow();
});

test('needsYou:answer records the answer, audits it with externalRef, and calls onChanged', async () => {
  await post({ externalRef: 'portfolio:action-7' });
  const res = await invoke('needsYou:answer', { app: 'portfolio', id: 'q-1', answer: 'yes' });
  expect(res.ok).toBe(true);
  expect(res.item).toMatchObject({ app: 'portfolio', id: 'q-1', status: 'answered', answer: 'yes' });
  expect(onChanged).toHaveBeenCalledTimes(1);
  const rows = auditRows().filter((r) => r.kind === 'needs_you_answered');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app: 'portfolio', id: 'q-1', answer: 'yes', externalRef: 'portfolio:action-7' });
  expect((await invoke('needsYou:list', undefined)).items).toHaveLength(0);
});

test('needsYou:answer omits externalRef from the row when the item has none', async () => {
  await post();
  const res = await invoke('needsYou:answer', { app: 'portfolio', id: 'q-1', answer: 'no' });
  expect(res.ok).toBe(true);
  const [row] = auditRows().filter((r) => r.kind === 'needs_you_answered');
  expect(row).toMatchObject({ app: 'portfolio', id: 'q-1', answer: 'no' });
  expect('externalRef' in row).toBe(false);
});

test('needsYou:answer with an unknown item or a non-option answer returns an error and writes nothing', async () => {
  await post();
  const before = fs.readFileSync(path.join(tmp, 'needs-you.json'), 'utf8');
  const missing = await invoke('needsYou:answer', { app: 'portfolio', id: 'nope', answer: 'yes' });
  expect(missing.ok).toBe(false);
  expect(typeof missing.error).toBe('string');
  expect(missing.error.length).toBeGreaterThan(10);
  const badAnswer = await invoke('needsYou:answer', { app: 'portfolio', id: 'q-1', answer: 'maybe' });
  expect(badAnswer.ok).toBe(false);
  expect(onChanged).not.toHaveBeenCalled();
  expect(auditRows().filter((r) => r.kind === 'needs_you_answered')).toHaveLength(0);
  expect(fs.readFileSync(path.join(tmp, 'needs-you.json'), 'utf8')).toBe(before);
});

test('needsYou:answer rejects a malformed payload', () => {
  expect(() => invoke('needsYou:answer', { app: 'portfolio', id: 'q-1' })).toThrow();
  expect(() => invoke('needsYou:answer', { app: 'portfolio', id: 'q-1', answer: 'yes', extra: 1 })).toThrow();
});
