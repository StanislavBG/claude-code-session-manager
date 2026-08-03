/**
 * transcripts-doFlush-array.test.cjs — unit tests for transcripts.cjs's
 * doFlush()/readDelta() handling of classifyLine's array-of-events shape.
 *
 * Covers: one line producing several events all land in sub.buffer flattened
 * (not nested per line), the 500-entry ring cap is enforced across that
 * flattened event stream rather than per line, and each event's byte `ref`
 * correctly points back at its own line in the transcript file on disk.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/transcripts-doFlush-array.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { subscribe, getBuffer, closeTab, transcriptPath } = require('../transcripts.cjs');

let cwd;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-doflush-test-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function writeTranscript(cwdArg, sessionId, lines) {
  const filePath = transcriptPath(cwdArg, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

test('a single multi-block line flattens into multiple buffered events', async () => {
  const sessionId = 'sess-multi';
  const tabId = 'tab-multi';
  writeTranscript(cwd, sessionId, [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'doing two things' },
          { type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Bash', id: 'tu-2', input: { command: 'pwd' } },
        ],
      },
    },
  ]);

  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);
  const buf = getBuffer(tabId);
  expect(buf).toHaveLength(3);
  expect(buf.map((e) => e.kind)).toEqual(['assistant', 'tool_use', 'tool_use']);
  closeTab(tabId);
});

test('the 500-entry ring cap is enforced across the flattened event stream, not per line', async () => {
  const sessionId = 'sess-cap';
  const tabId = 'tab-cap';
  // 200 lines * 3 events each = 600 events > 500 cap.
  const lines = Array.from({ length: 200 }, (_, i) => ({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: `line ${i}` },
        { type: 'tool_use', name: 'Bash', id: `tu-${i}-a`, input: { command: 'ls' } },
        { type: 'tool_use', name: 'Bash', id: `tu-${i}-b`, input: { command: 'pwd' } },
      ],
    },
  }));
  writeTranscript(cwd, sessionId, lines);

  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);
  const buf = getBuffer(tabId);
  expect(buf).toHaveLength(500);
  // Oldest events were evicted — the last event of the last line must be present.
  expect(buf[buf.length - 1].data.id).toBe('tu-199-b');
  closeTab(tabId);
});

test('each event ref points at its own line — re-reading those bytes reproduces that exact line', async () => {
  const sessionId = 'sess-ref';
  const tabId = 'tab-ref';
  const filePath = writeTranscript(cwd, sessionId, [
    { type: 'user', message: { content: 'first line — some unicode: héllo 🎉' } },
    { type: 'assistant', message: { content: 'second line' } },
  ]);

  const res = await subscribe({ tabId, cwd, sessionUuid: sessionId });
  expect(res.ok).toBe(true);
  const buf = getBuffer(tabId);
  expect(buf).toHaveLength(2);

  const fd = fs.openSync(filePath, 'r');
  try {
    for (const ev of buf) {
      expect(ev.ref).toBeTruthy();
      expect(ev.ref.filePath).toBe(filePath);
      const readBuf = Buffer.alloc(ev.ref.byteLength);
      fs.readSync(fd, readBuf, 0, ev.ref.byteLength, ev.ref.byteOffset);
      const parsed = JSON.parse(readBuf.toString('utf8'));
      expect(parsed.type).toBe(ev.kind);
    }
  } finally {
    fs.closeSync(fd);
  }
  closeTab(tabId);
});
