/**
 * transcripts-batch-flush.test.cjs — unit tests for the batched IPC flush
 * (PRD transcript-batch-flush): transcripts.cjs's doFlush now sends the
 * events produced by ONE flush as a SINGLE `transcript:event:<tabId>` IPC
 * message (an array), instead of one message per event, while still
 * recording one OTEL span per event and preserving exact event order.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/transcripts-batch-flush.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  subscribe,
  closeTab,
  transcriptPath,
  attachWindow,
  __getSubForTest,
  __doFlushForTest,
  MAX_EVENTS_PER_BATCH,
} = require('../transcripts.cjs');
const otel = require('../otel.cjs');

let cwd;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-batch-flush-test-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(path.dirname(transcriptPath(cwd, 'x')), { recursive: true, force: true });
  attachWindow(null);
});

function writeTranscript(cwdArg, sessionId, lines) {
  const filePath = transcriptPath(cwdArg, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function appendTranscript(filePath, lines) {
  fs.appendFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** A fake BrowserWindow that records every webContents.send call. */
function makeFakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

function assistantLine(text, toolId) {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text },
        { type: 'tool_use', name: 'Bash', id: toolId, input: { command: 'ls' } },
      ],
    },
  };
}

test('one flush with several multi-event lines sends exactly ONE IPC message carrying the whole ordered batch', async () => {
  const sessionId = 'sess-one-batch';
  const tabId = 'tab-one-batch';
  const filePath = writeTranscript(cwd, sessionId, []);

  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);

  const win = makeFakeWindow();
  attachWindow(win);

  // 5 lines * 2 events each = 10 events, well under MAX_EVENTS_PER_BATCH.
  appendTranscript(
    filePath,
    Array.from({ length: 5 }, (_, i) => assistantLine(`line ${i}`, `tu-${i}`)),
  );
  const sub = __getSubForTest(tabId);
  await sub.watcher?.close();
  await __doFlushForTest(sub);

  const messages = win.sent.filter((m) => m.channel === `transcript:event:${tabId}`);
  expect(messages).toHaveLength(1);
  expect(Array.isArray(messages[0].payload)).toBe(true);
  expect(messages[0].payload).toHaveLength(10);
  // Event order preserved: text/tool_use pairs in line order.
  expect(messages[0].payload.map((e) => e.kind)).toEqual([
    'assistant', 'tool_use', 'assistant', 'tool_use', 'assistant', 'tool_use', 'assistant', 'tool_use', 'assistant', 'tool_use',
  ]);
  expect(messages[0].payload.map((e) => e.data?.id ?? e.data).filter(Boolean)).toEqual(
    expect.arrayContaining(['tu-0', 'tu-1', 'tu-2', 'tu-3', 'tu-4']),
  );

  closeTab(tabId);
});

test('order is preserved exactly across a multi-event flush (matches per-event order semantics)', async () => {
  const sessionId = 'sess-order';
  const tabId = 'tab-order';
  const filePath = writeTranscript(cwd, sessionId, []);
  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);

  const win = makeFakeWindow();
  attachWindow(win);

  appendTranscript(filePath, [
    { type: 'user', message: { content: 'first' } },
    assistantLine('second', 'tu-order-1'),
    { type: 'user', message: { content: 'third' } },
  ]);
  const sub = __getSubForTest(tabId);
  await sub.watcher?.close();
  await __doFlushForTest(sub);

  const messages = win.sent.filter((m) => m.channel === `transcript:event:${tabId}`);
  expect(messages).toHaveLength(1);
  const kinds = messages[0].payload.map((e) => e.kind);
  const texts = messages[0].payload.map((e) =>
    typeof e.data === 'string' ? e.data : e.data?.id ?? e.data?.message?.content,
  );
  expect(kinds).toEqual(['user', 'assistant', 'tool_use', 'user']);
  expect(texts).toEqual(['first', 'second', 'tu-order-1', 'third']);

  closeTab(tabId);
});

test('OTEL still records ONE span per event, not one per batch', async () => {
  const sessionId = 'sess-otel-batch';
  const tabId = 'tab-otel-batch';
  const filePath = writeTranscript(cwd, sessionId, []);
  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);

  const win = makeFakeWindow();
  attachWindow(win);

  const spy = vi.spyOn(otel, 'recordTranscriptEvent');
  const before = spy.mock.calls.length;

  appendTranscript(
    filePath,
    Array.from({ length: 6 }, (_, i) => assistantLine(`otel line ${i}`, `otel-tu-${i}`)),
  );
  const sub = __getSubForTest(tabId);
  await sub.watcher?.close();
  await __doFlushForTest(sub);

  // 6 lines * 2 events = 12 spans, sent as one IPC batch.
  expect(spy.mock.calls.length - before).toBe(12);
  const messages = win.sent.filter((m) => m.channel === `transcript:event:${tabId}`);
  expect(messages).toHaveLength(1);
  expect(messages[0].payload).toHaveLength(12);

  spy.mockRestore();
  closeTab(tabId);
});

test('backpressure: a flush producing more than MAX_EVENTS_PER_BATCH events is sent as multiple ordered, capped batches', async () => {
  const sessionId = 'sess-backpressure';
  const tabId = 'tab-backpressure';
  const filePath = writeTranscript(cwd, sessionId, []);
  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);

  const win = makeFakeWindow();
  attachWindow(win);

  // Each line yields 2 events; pick a line count that produces more than
  // 2x the cap so at least 3 batches are required.
  const lineCount = Math.ceil((MAX_EVENTS_PER_BATCH * 2.5) / 2);
  const totalEvents = lineCount * 2;
  appendTranscript(
    filePath,
    Array.from({ length: lineCount }, (_, i) => assistantLine(`bp line ${i}`, `bp-tu-${i}`)),
  );
  const sub = __getSubForTest(tabId);
  await sub.watcher?.close();
  await __doFlushForTest(sub);

  const messages = win.sent.filter((m) => m.channel === `transcript:event:${tabId}`);
  expect(messages.length).toBeGreaterThan(1);
  for (const m of messages) {
    expect(m.payload.length).toBeLessThanOrEqual(MAX_EVENTS_PER_BATCH);
  }
  // Concatenating every batch in send order reproduces the full ordered
  // event list — no event dropped, none duplicated, none reordered.
  const flattened = messages.flatMap((m) => m.payload);
  expect(flattened).toHaveLength(totalEvents);
  const ids = flattened.map((e) => (e.kind === 'tool_use' ? e.data.id : null)).filter(Boolean);
  expect(ids).toEqual(Array.from({ length: lineCount }, (_, i) => `bp-tu-${i}`));

  closeTab(tabId);
});

test('benchmark: IPC message count drops from N-per-event to a small number of batches for a 20+ event flush', async () => {
  const sessionId = 'sess-benchmark';
  const tabId = 'tab-benchmark';
  const filePath = writeTranscript(cwd, sessionId, []);
  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);

  const win = makeFakeWindow();
  attachWindow(win);

  // 12 lines * 2 events = 24 events — at least 20, comfortably under one cap.
  const lineCount = 12;
  appendTranscript(
    filePath,
    Array.from({ length: lineCount }, (_, i) => assistantLine(`bench line ${i}`, `bench-tu-${i}`)),
  );
  const sub = __getSubForTest(tabId);
  await sub.watcher?.close();
  await __doFlushForTest(sub);

  const messages = win.sent.filter((m) => m.channel === `transcript:event:${tabId}`);
  const totalEvents = messages.reduce((n, m) => n + m.payload.length, 0);
  expect(totalEvents).toBeGreaterThanOrEqual(20);

  // BEFORE this PRD: doFlush sent one IPC message PER EVENT, so a 24-event
  // flush meant 24 messages and (in the renderer) 24 store commits. AFTER:
  // one message per flush (bounded by MAX_EVENTS_PER_BATCH), so the same
  // flush is 1 message — a >20x reduction in IPC round-trips, and the
  // renderer's live.ts/chat.ts now fold that one message into exactly one
  // store commit each (see live.test.ts / chatTranscriptFeed.test.ts).
  const beforeMessageCount = totalEvents; // one send per event, historically
  const afterMessageCount = messages.length;
  expect(afterMessageCount).toBeLessThan(beforeMessageCount);
  expect(afterMessageCount).toBe(1);

  closeTab(tabId);
});
