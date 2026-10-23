/**
 * chatRunner-external-send-ack — enqueueExternalPrompt resolves with the
 * renderer's reported disposition (or unconfirmed on timeout / no window).
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

const report = (p) => handlers.get('chat:external-send-result')({}, p);

test('broadcast carries a requestId and the report resolves the promise', async () => {
  const p = cr.enqueueExternalPrompt('tab-1', 'hello', { sessionId: 's', cwd: '/c' });
  expect(sent).toHaveLength(1);
  const { channel, payload } = sent[0];
  expect(channel).toBe('chat:external-send');
  expect(typeof payload.requestId).toBe('string');
  expect(payload).toMatchObject({ tabId: 'tab-1', prompt: 'hello', sessionId: 's', cwd: '/c' });
  await report({ requestId: payload.requestId, disposition: 'refused', reason: 'completed' });
  await expect(p).resolves.toEqual({ disposition: 'refused', reason: 'completed' });
  // already settled: no-op
  await report({ requestId: payload.requestId, disposition: 'sent' });
});

test('timeout yields unconfirmed/timeout', async () => {
  const p = cr.enqueueExternalPrompt('tab-1', 'hi');
  await vi.advanceTimersByTimeAsync(cr.EXTERNAL_SEND_ACK_TIMEOUT_MS + 1);
  await expect(p).resolves.toEqual({ disposition: 'unconfirmed', reason: 'timeout' });
});

test('no window yields unconfirmed/no-window without broadcasting', async () => {
  cr.attachWindow(null);
  await expect(cr.enqueueExternalPrompt('tab-1', 'hi')).resolves.toEqual({ disposition: 'unconfirmed', reason: 'no-window' });
  expect(sent).toHaveLength(0);
});

test('unknown requestId and invalid payload are ignored', async () => {
  const p = cr.enqueueExternalPrompt('tab-1', 'hi');
  const { requestId } = sent[0].payload;
  await report({ requestId: 'nope', disposition: 'sent' });
  expect(() => report({ requestId, disposition: 'bogus' })).toThrow();
  expect(() => report({ disposition: 'sent' })).toThrow();
  await vi.advanceTimersByTimeAsync(cr.EXTERNAL_SEND_ACK_TIMEOUT_MS + 1);
  await expect(p).resolves.toEqual({ disposition: 'unconfirmed', reason: 'timeout' });
});
