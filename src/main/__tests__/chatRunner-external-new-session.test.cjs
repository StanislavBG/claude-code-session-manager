/**
 * chatRunner-external-new-session — startExternalNewSession resolves with the
 * Epic the renderer minted (or a typed failure), and isTabBusy reads lane state.
 */
'use strict';

import { test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
const Module = require('node:module');

const handlers = new Map();
let cr;
let sent;

beforeAll(() => {
  const electronPath = require.resolve('electron');
  const em = new Module(electronPath);
  em.filename = electronPath; em.loaded = true;
  em.exports = { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} } };
  require.cache[electronPath] = em;
  cr = require('../chatRunner.cjs');
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
const payload = { macroId: 'm-1', cwd: '/proj' };

test('no window resolves no-window at once without broadcasting', async () => {
  cr.attachWindow(null);
  await expect(cr.startExternalNewSession(payload)).resolves.toEqual({
    ok: false, reason: 'no-window', error: 'Session Manager window is not open',
  });
  expect(sent).toHaveLength(0);
});

test('broadcast carries a fresh requestId; ok report resolves with the epicId', async () => {
  const p = cr.startExternalNewSession(payload);
  expect(sent).toHaveLength(1);
  expect(sent[0].channel).toBe('chat:external-new-session');
  const { requestId } = sent[0].payload;
  expect(typeof requestId).toBe('string');
  expect(sent[0].payload).toMatchObject(payload);
  await report({ requestId: 'unknown-id', ok: true, epicId: 'other' }); // ignored
  await report({ requestId, ok: true, epicId: 'epic-abc' });
  await expect(p).resolves.toEqual({ ok: true, epicId: 'epic-abc' });
  // already settled: no-op
  await report({ requestId, ok: false, error: 'late' });
});

test('error report resolves launch-failed with the renderer error', async () => {
  const p = cr.startExternalNewSession(payload);
  const { requestId } = sent[0].payload;
  await report({ requestId, ok: false, error: 'boom' });
  await expect(p).resolves.toEqual({ ok: false, reason: 'launch-failed', error: 'boom' });
});

test('ok without epicId is launch-failed with a default error', async () => {
  const p = cr.startExternalNewSession(payload);
  await report({ requestId: sent[0].payload.requestId, ok: true });
  await expect(p).resolves.toEqual({ ok: false, reason: 'launch-failed', error: 'renderer could not start the session' });
});

test('timeout resolves timeout and later reports are ignored', async () => {
  expect(cr.EXTERNAL_NEW_SESSION_TIMEOUT_MS).toBe(30000);
  const p = cr.startExternalNewSession(payload);
  const { requestId } = sent[0].payload;
  await vi.advanceTimersByTimeAsync(cr.EXTERNAL_NEW_SESSION_TIMEOUT_MS + 1);
  const r = await p;
  expect(r).toMatchObject({ ok: false, reason: 'timeout' });
  await report({ requestId, ok: true, epicId: 'epic-late' });
});

test('isTabBusy is false for an unknown tab', () => {
  expect(cr.isTabBusy('no-such-tab')).toBe(false);
});
