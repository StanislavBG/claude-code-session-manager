/**
 * chatRunnerExternalResult — the renderer's chat:external-new-session-result
 * report may carry the background build it queued (entryId, slug, stage);
 * the schema accepts those fields, settleExternalNewSession passes them to the
 * awaiting promise, and startExternalNewSession forwards reviewStage as-is.
 */
'use strict';

import { test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
const Module = require('node:module');

const handlers = new Map();
let cr;
let schemas;
let sent;

beforeAll(() => {
  const electronPath = require.resolve('electron');
  const em = new Module(electronPath);
  em.filename = electronPath; em.loaded = true;
  em.exports = { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} } };
  require.cache[electronPath] = em;
  cr = require('../chatRunner.cjs');
  ({ schemas } = require('../ipcSchemas.cjs'));
  cr.registerChatHandlers();
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
});

afterEach(() => {
  cr.attachWindow(null);
  vi.useRealTimers();
});

const report = (p) => handlers.get('chat:external-new-session-result')({}, p);
const base = { requestId: 'r-1', ok: true, epicId: 'epic-abc' };

test('schema accepts entryId, slug and stage', () => {
  const s = schemas.chatExternalNewSessionResult;
  for (const stage of ['review', 'final', null]) {
    expect(s.safeParse({ ...base, entryId: 'vid-abc123', slug: 'My post', stage }).success).toBe(true);
  }
  expect(s.safeParse(base).success).toBe(true);
  expect(s.parse({ ...base, entryId: 'vid-1', slug: 's', stage: 'review' }))
    .toEqual({ ...base, entryId: 'vid-1', slug: 's', stage: 'review' });
});

test('schema rejects malformed new fields and still rejects unknown keys', () => {
  const s = schemas.chatExternalNewSessionResult;
  const bad = [
    { entryId: 'Vid-ABC' },
    { entryId: '-lead' },
    { entryId: 'a'.repeat(65) },
    { entryId: '../x' },
    { slug: '' },
    { slug: 'x'.repeat(201) },
    { slug: 5 },
    { stage: 'draft' },
    { stage: true },
    { bogus: 1 },
  ];
  for (const extra of bad) expect(s.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(false);
  expect(s.safeParse({ ...base, entryId: 'a'.repeat(64), slug: 'x'.repeat(200) }).success).toBe(true);
});

test('settleExternalNewSession passes entryId, slug and stage through', async () => {
  const p = cr.startExternalNewSession({ macroId: 'm-1', cwd: '/proj' });
  const { requestId } = sent[0].payload;
  await report({ requestId, ok: true, epicId: 'epic-abc', entryId: 'vid-1', slug: 'post-one', stage: 'review' });
  await expect(p).resolves.toEqual({ ok: true, epicId: 'epic-abc', entryId: 'vid-1', slug: 'post-one', stage: 'review' });
});

test('stage null is passed through; absent fields stay absent', async () => {
  const p1 = cr.startExternalNewSession({ macroId: 'm-1', cwd: '/proj' });
  await report({ requestId: sent[0].payload.requestId, ok: true, epicId: 'e1', entryId: 'vid-2', stage: null });
  await expect(p1).resolves.toEqual({ ok: true, epicId: 'e1', entryId: 'vid-2', stage: null });

  const p2 = cr.startExternalNewSession({ macroId: 'm-1', cwd: '/proj' });
  await report({ requestId: sent[1].payload.requestId, ok: true, epicId: 'e2' });
  await expect(p2).resolves.toEqual({ ok: true, epicId: 'e2' });
});

test('a failed report drops build fields', async () => {
  const p = cr.startExternalNewSession({ macroId: 'm-1', cwd: '/proj' });
  await report({ requestId: sent[0].payload.requestId, ok: false, error: 'boom', entryId: 'vid-3' });
  await expect(p).resolves.toEqual({ ok: false, reason: 'launch-failed', error: 'boom' });
});

test('startExternalNewSession forwards reviewStage unchanged', async () => {
  for (const reviewStage of [true, false]) {
    sent = [];
    const p = cr.startExternalNewSession({ macroId: 'm-1', cwd: '/proj', reviewStage });
    expect(sent[0].payload.reviewStage).toBe(reviewStage);
    await report({ requestId: sent[0].payload.requestId, ok: true, epicId: 'e' });
    await p;
  }
  sent = [];
  const p = cr.startExternalNewSession({ macroId: 'm-1', cwd: '/proj' });
  expect('reviewStage' in sent[0].payload).toBe(false);
  await report({ requestId: sent[0].payload.requestId, ok: true, epicId: 'e' });
  await p;
});
