/**
 * historyAggregatorDedupe.test.cjs — a Claude transcript writes one line per
 * content block of a message and repeats that message's usage on each line.
 * scanAggrLines / parseJSONL must count each message.id once (largest value
 * per token field), also across tail parses of a growing file.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/historyAggregatorDedupe.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpDir;
let historyAggregator;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-dedupe-test-'));
  delete require.cache[require.resolve('../historyAggregator.cjs')];
  historyAggregator = require('../historyAggregator.cjs');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MODEL = 'claude-opus-4-1';

function line(id, tokens, model = MODEL) {
  const message = {
    role: 'assistant',
    model,
    usage: {
      input_tokens: tokens.in ?? 0,
      output_tokens: tokens.out ?? 0,
      cache_read_input_tokens: tokens.cacheR ?? 0,
      cache_creation_input_tokens: tokens.cacheC ?? 0,
    },
  };
  if (id) message.id = id;
  return JSON.stringify({ timestamp: '2026-11-21T10:00:00.000Z', message });
}

function emptyAcc() {
  return {
    promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, toolCallCount: 0, toolBreakdown: {}, byModel: {}, errorCount: 0,
  };
}

function totals(r) {
  return {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
  };
}

test('three lines of one message.id count once with the largest values', () => {
  const acc = emptyAcc();
  historyAggregator.scanAggrLines([
    line('msg_a', { in: 10, out: 1, cacheR: 100, cacheC: 50 }),
    line('msg_a', { in: 10, out: 7, cacheR: 100, cacheC: 50 }),
    line('msg_a', { in: 10, out: 30, cacheR: 100, cacheC: 50 }),
  ], acc, false);
  expect(totals(acc)).toEqual({ inputTokens: 10, outputTokens: 30, cacheReadTokens: 100, cacheCreationTokens: 50 });
  expect(acc.byModel[MODEL]).toEqual(totals(acc));
});

test('two different ids count twice', () => {
  const acc = emptyAcc();
  historyAggregator.scanAggrLines([
    line('msg_a', { in: 10, out: 5 }),
    line('msg_b', { in: 20, out: 6 }),
  ], acc, false);
  expect(acc.inputTokens).toBe(30);
  expect(acc.outputTokens).toBe(11);
  expect(acc.byModel[MODEL]).toEqual(totals(acc));
});

test('lines without an id add as before', () => {
  const acc = emptyAcc();
  historyAggregator.scanAggrLines([
    line(null, { in: 10, out: 5 }),
    line(null, { in: 10, out: 5 }),
  ], acc, false);
  expect(acc.inputTokens).toBe(20);
  expect(acc.outputTokens).toBe(10);
  expect(acc.byModel[MODEL]).toEqual(totals(acc));
});

test('prompt, tool and error counts are unchanged by dedupe', () => {
  const acc = emptyAcc();
  const withTool = (id) => JSON.stringify({
    message: {
      id, role: 'assistant', model: MODEL, stop_reason: 'error',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', name: 'Bash' }],
    },
  });
  historyAggregator.scanAggrLines([
    JSON.stringify({ role: 'user' }),
    withTool('msg_a'),
    withTool('msg_a'),
  ], acc, false);
  expect(acc.promptCount).toBe(1);
  expect(acc.toolCallCount).toBe(2);
  expect(acc.toolBreakdown).toEqual({ Bash: 2 });
  expect(acc.errorCount).toBe(2);
  expect(acc.outputTokens).toBe(1);
});

test('a repeated id that arrives in a later tail parse does not add', async () => {
  const file = path.join(tmpDir, 'grow.jsonl');
  fs.writeFileSync(file, line('msg_a', { in: 10, out: 2, cacheR: 100 }) + '\n', 'utf8');
  let st = fs.statSync(file);
  const first = await historyAggregator.parseJSONL(file, st);
  expect(first.result.outputTokens).toBe(2);

  fs.appendFileSync(file, [
    line('msg_a', { in: 10, out: 9, cacheR: 100 }),
    line('msg_b', { in: 3, out: 4 }),
    line(null, { in: 1, out: 1 }),
  ].join('\n') + '\n', 'utf8');
  st = fs.statSync(file);
  const second = await historyAggregator.parseJSONL(file, st);
  expect(second.cacheHit).toBe(false);
  expect(totals(second.result)).toEqual({ inputTokens: 14, outputTokens: 14, cacheReadTokens: 100, cacheCreationTokens: 0 });
  expect(second.result.byModel[MODEL]).toEqual(totals(second.result));

  // Third read: msg_a again, with a smaller value — must not add anything.
  fs.appendFileSync(file, line('msg_a', { in: 10, out: 3, cacheR: 100 }) + '\n', 'utf8');
  st = fs.statSync(file);
  const third = await historyAggregator.parseJSONL(file, st);
  expect(totals(third.result)).toEqual(totals(second.result));
  expect(third.result.byModel[MODEL]).toEqual(totals(third.result));

  // A full parse of the same file agrees with the incremental result.
  delete require.cache[require.resolve('../historyAggregator.cjs')];
  const fresh = require('../historyAggregator.cjs');
  const full = await fresh.parseJSONL(file, st);
  expect(totals(full.result)).toEqual(totals(third.result));
  expect(full.result.byModel).toEqual(third.result.byModel);
});
