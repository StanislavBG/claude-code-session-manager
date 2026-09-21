/**
 * transcriptsUsageFor.test.cjs — unit tests for transcripts.cjs's usageFor(),
 * the batched token-usage reader backing the `transcript:usageFor` IPC (Epics
 * workspace tokens metric).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/transcriptsUsageFor.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { usageFor, transcriptPath } = require('../transcripts.cjs');

let cwd;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-usage-test-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  // writeTranscript mkdir -p's this run's folder under the REAL
  // ~/.claude/projects (that's where transcriptPath resolves to), so leaving
  // it behind accumulates one phantom project directory per test run. Thousands
  // had piled up before this cleanup existed, and Home counted every one as a
  // project. Remove it with the tmp cwd it mirrors.
  fs.rmSync(path.dirname(transcriptPath(cwd, 'x')), { recursive: true, force: true });
});

function writeTranscript(cwdArg, sessionId, lines) {
  const filePath = transcriptPath(cwdArg, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

test('sums input/output tokens across usage events in a session transcript', async () => {
  const sessionId = 'sess-aaaa-1111';
  writeTranscript(cwd, sessionId, [
    { type: 'assistant', usage: { input_tokens: 100, output_tokens: 20 } },
    { type: 'assistant', usage: { input_tokens: 50, output_tokens: 10 } },
    { type: 'user', message: { content: 'no usage here' } },
  ]);

  const result = await usageFor(cwd, [sessionId]);
  expect(result[sessionId]).toEqual({ inputTokens: 150, outputTokens: 30 });
});

test('maps a session with no transcript file to null', async () => {
  const result = await usageFor(cwd, ['no-such-session']);
  expect(result['no-such-session']).toBeNull();
});

test('batches multiple sessions in one call', async () => {
  writeTranscript(cwd, 'sess-a', [{ usage: { input_tokens: 5, output_tokens: 1 } }]);
  writeTranscript(cwd, 'sess-b', [{ usage: { input_tokens: 7, output_tokens: 2 } }]);

  const result = await usageFor(cwd, ['sess-a', 'sess-b', 'sess-missing']);
  expect(result).toEqual({
    'sess-a': { inputTokens: 5, outputTokens: 1 },
    'sess-b': { inputTokens: 7, outputTokens: 2 },
    'sess-missing': null,
  });
});

test('a repeat call against an unchanged file returns the same cached totals', async () => {
  const sessionId = 'sess-cache';
  writeTranscript(cwd, sessionId, [{ usage: { input_tokens: 10, output_tokens: 5 } }]);

  const first = await usageFor(cwd, [sessionId]);
  const second = await usageFor(cwd, [sessionId]);
  expect(second[sessionId]).toEqual(first[sessionId]);
  expect(second[sessionId]).toEqual({ inputTokens: 10, outputTokens: 5 });
});

test('a growing transcript is re-summed after the file mtime/size change', async () => {
  const sessionId = 'sess-grow';
  writeTranscript(cwd, sessionId, [{ usage: { input_tokens: 10, output_tokens: 5 } }]);
  const before = await usageFor(cwd, [sessionId]);
  expect(before[sessionId]).toEqual({ inputTokens: 10, outputTokens: 5 });

  // Force a distinct mtime — some filesystems have coarse mtime resolution.
  const filePath = transcriptPath(cwd, sessionId);
  const future = new Date(Date.now() + 5000);
  fs.appendFileSync(filePath, JSON.stringify({ usage: { input_tokens: 3, output_tokens: 1 } }) + '\n');
  fs.utimesSync(filePath, future, future);

  const after = await usageFor(cwd, [sessionId]);
  expect(after[sessionId]).toEqual({ inputTokens: 13, outputTokens: 6 });
});

// ── incremental tail parse + bounded cache ─────────────────────────────────

const fsp = require('node:fs/promises');
const transcripts = require('../transcripts.cjs');

function fromScratch(filePath) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o.usage || {};
    inputTokens += u.input_tokens ?? 0;
    outputTokens += u.output_tokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

test('incremental result equals a from-scratch parse across 5 appends (partial line + repeated id)', async () => {
  const sessionId = 'sess-incr';
  const filePath = writeTranscript(cwd, sessionId, [
    { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } },
  ]);
  const check = async () => {
    const r = await usageFor(cwd, [sessionId]);
    expect(r[sessionId]).toEqual(fromScratch(filePath));
  };
  await check();
  const l2 = JSON.stringify({ id: 'm2', usage: { input_tokens: 20, output_tokens: 2 } });
  // 1: append ending mid-line
  fs.appendFileSync(filePath, l2.slice(0, 15));
  await check();
  // 2: complete that line
  fs.appendFileSync(filePath, l2.slice(15) + '\n');
  await check();
  // 3: repeat an earlier message id (full parse sums it again)
  fs.appendFileSync(filePath, JSON.stringify({ id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } }) + '\n');
  await check();
  // 4: non-usage + malformed line
  fs.appendFileSync(filePath, JSON.stringify({ type: 'user' }) + '\nnot json\n');
  await check();
  // 5: multibyte content then usage
  fs.appendFileSync(filePath, JSON.stringify({ t: 'héllo 日本', usage: { input_tokens: 4, output_tokens: 4 } }) + '\n');
  await check();
  expect((await usageFor(cwd, [sessionId]))[sessionId]).toEqual({ inputTokens: 44, outputTokens: 8 });
});

test('the call after a one-line append reads < 4 KB from disk', async () => {
  const sessionId = 'sess-bytes';
  const big = Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(100), usage: { input_tokens: 1, output_tokens: 1 } }));
  const filePath = writeTranscript(cwd, sessionId, big);
  await usageFor(cwd, [sessionId]);
  expect(fs.statSync(filePath).size).toBeGreaterThan(200_000);

  fs.appendFileSync(filePath, JSON.stringify({ usage: { input_tokens: 5, output_tokens: 5 } }) + '\n');
  const fh = await fsp.open(filePath, 'r');
  const proto = Object.getPrototypeOf(fh);
  await fh.close();
  const orig = proto.read;
  const lengths = [];
  const spy = vi.spyOn(proto, 'read').mockImplementation(function (buf, off, len, pos) {
    lengths.push(len);
    return orig.call(this, buf, off, len, pos);
  });
  try {
    const r = await usageFor(cwd, [sessionId]);
    expect(r[sessionId]).toEqual({ inputTokens: 2005, outputTokens: 2005 });
  } finally {
    spy.mockRestore();
  }
  expect(lengths.length).toBeGreaterThan(0);
  expect(lengths.reduce((a, b) => a + b, 0)).toBeLessThan(4096);
});

test('truncation / replacement triggers a full re-parse', async () => {
  const sessionId = 'sess-trunc';
  const filePath = writeTranscript(cwd, sessionId, [
    { usage: { input_tokens: 100, output_tokens: 100 } },
    { usage: { input_tokens: 100, output_tokens: 100 } },
  ]);
  await usageFor(cwd, [sessionId]);
  fs.writeFileSync(filePath, JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 } }) + '\n');
  expect((await usageFor(cwd, [sessionId]))[sessionId]).toEqual({ inputTokens: 1, outputTokens: 2 });
});

test('usageCache is bounded and evicts the least-recently-used entry', async () => {
  const cache = transcripts.__usageCacheForTest;
  const max = transcripts.__usageCacheMaxForTest;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-usage-lru-'));
  try {
    const files = [];
    for (let i = 0; i < max + 5; i++) {
      const f = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(f, JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      files.push(f);
    }
    const before = cache.size;
    for (const f of files) {
      // usageForOne is reached through usageFor's path; call via a cwd-independent route.
      await transcripts.__usageForOneForTest(f);
    }
    expect(cache.size).toBeLessThanOrEqual(max);
    expect(before).toBeLessThanOrEqual(max);
    expect(cache.has(files[0])).toBe(false);
    expect(cache.has(files[files.length - 1])).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
