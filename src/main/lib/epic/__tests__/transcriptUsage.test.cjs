/**
 * transcriptUsage.test.cjs — summarizeTranscriptUsage counts each model call
 * once (rows sharing message.id), skips sidechain/synthetic/malformed rows,
 * reports largestContext and an approximate per-source token breakdown.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/transcriptUsage.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { summarizeTranscriptUsage, summarizeTranscriptFile } = require('../transcriptUsage.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function asst(id, usage, content, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: { id, model: 'claude-opus-5-5', usage, content },
    ...extra,
  });
}
function user(content, extra = {}) {
  return JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...extra });
}
const u = (i, cw, cr, o) => ({
  input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o,
});

function fixture() {
  return [
    user('x'.repeat(40)), // 10 tokens of user_prompt
    user('<meta>' + 'y'.repeat(400), { isMeta: true }), // ignored
    // One call written as three rows (one per content block) sharing message.id.
    asst('msg_1', u(10, 100, 0, 1), [{ type: 'thinking', thinking: '...' }]),
    asst('msg_1', u(10, 100, 0, 1), [{ type: 'text', text: 'hi' }]),
    asst('msg_1', u(10, 100, 0, 50), [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'r'.repeat(80) }]), // Read: 20
    user([{ type: 'tool_result', tool_use_id: 'tu_missing', content: [{ type: 'text', text: 'z'.repeat(8) }] }]), // unknown: 2
    'not json {',
    '',
    asst('msg_2', u(5, 0, 2000, 20), [{ type: 'text', text: 'done' }]),
    // Sidechain call — ignored.
    asst('msg_side', u(9999, 9999, 9999, 9999), [{ type: 'text', text: 's' }], { isSidechain: true }),
    // Synthetic call — ignored.
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { id: 'msg_syn', model: '<synthetic>', usage: u(1, 1, 1, 1), content: [] } }),
    // Assistant row without usage — skipped.
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { id: 'msg_nou', model: 'claude-opus-5-5', content: [] } }),
  ];
}

test('dedupes rows by message.id and ignores sidechain, synthetic, malformed rows', () => {
  const s = summarizeTranscriptUsage(fixture());
  expect(s.calls).toBe(2);
  expect(s.inputTokens).toBe(15);
  expect(s.cacheWriteTokens).toBe(100);
  expect(s.cacheReadTokens).toBe(2000);
  expect(s.outputTokens).toBe(70);
  expect(s.models).toEqual({ 'claude-opus-5-5': 2 });
});

test('largestContext is the largest single-call input+cache sum', () => {
  const s = summarizeTranscriptUsage(fixture());
  expect(s.largestContext).toBe(2005);
});

test('bySource attributes tool results, unknown tools, user prompts, model output', () => {
  const s = summarizeTranscriptUsage(fixture());
  expect(s.bySource).toEqual([
    { source: 'model_output', approxTokens: 70 },
    { source: 'tool:Read', approxTokens: 20 },
    { source: 'user_prompt', approxTokens: 10 },
    { source: 'tool:unknown', approxTokens: 2 },
  ]);
});

test('never throws on garbage input', () => {
  expect(() => summarizeTranscriptUsage(['{', 'null', '42', '[]', JSON.stringify({ type: 'user' })])).not.toThrow();
  const s = summarizeTranscriptUsage([]);
  expect(s.calls).toBe(0);
  expect(s.largestContext).toBe(0);
  expect(s.bySource).toEqual([]);
});

test('summarizeTranscriptFile streams a file and matches the in-memory summary', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-tu-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, fixture().join('\n') + '\n');
  expect(await summarizeTranscriptFile(file)).toEqual(summarizeTranscriptUsage(fixture()));
});

test('summarizeTranscriptFile resolves null for a missing file', async () => {
  expect(await summarizeTranscriptFile(path.join(os.tmpdir(), 'sm-tu-does-not-exist.jsonl'))).toBeNull();
});
