/**
 * transcriptsUsageFor.test.cjs — unit tests for transcripts.cjs's usageFor(),
 * the batched token-usage reader backing the `transcript:usageFor` IPC (Epics
 * workspace tokens metric).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/transcriptsUsageFor.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';

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
