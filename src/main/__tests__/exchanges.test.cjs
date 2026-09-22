'use strict';

/**
 * Unit test for exchanges.cjs.
 *
 * PRD 1391: exchanges now write to <cwd>/session-manager-operations/
 * prompt-sessions/exchanges.jsonl instead of the old global
 * ~/.claude/knowledge-log/exchanges/<encodeCwd(cwd)>.jsonl store — each test
 * uses a fresh tmp directory as its project `cwd` so no real project state is
 * touched.
 *
 * Stubs summarize.cjs to avoid any network calls.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/exchanges.test.cjs
 */

import { test, describe, beforeEach } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exchanges-test-'));
}

function exchangesLogPath(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'exchanges.jsonl');
}

function stubSummarize(fn) {
  const summarizePath = require.resolve('../lib/summarize.cjs');
  delete require.cache[summarizePath];
  require.cache[summarizePath] = {
    id: summarizePath,
    filename: summarizePath,
    loaded: true,
    exports: { summarize: fn },
  };
}

beforeEach(() => {
  delete require.cache[require.resolve('../exchanges.cjs')];
});

describe('recordExchange', () => {
  test('writes a complete record when summarize succeeds', async () => {
    stubSummarize(async () => ({ summary: 'Test summary.', model: 'claude-haiku-4-5' }));

    const { recordExchange } = require('../exchanges.cjs');

    const cwd = mkTmpProject();
    const sessionId = 'sess-abc-123';
    const prompt = 'What is 2+2?';
    const result = 'The answer is 4.';

    await recordExchange({ sessionId, cwd, prompt, result });

    const content = await fsp.readFile(exchangesLogPath(cwd), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'should write exactly one line');

    const record = JSON.parse(lines[0]);
    assert.equal(record.sessionId, sessionId);
    assert.equal(record.cwd, cwd);
    assert.equal(record.prompt, prompt);
    assert.equal(record.result, result);
    assert.equal(record.summary, 'Test summary.');
    assert.equal(record.model, 'claude-haiku-4-5');
    assert.ok(record.ts, 'ts field should be present');
    assert.equal(record.degraded, undefined, 'should not have degraded field on success');
  });

  test('still writes a record when summarize degrades (no_api_key)', async () => {
    stubSummarize(async (text) => ({
      summary: text.slice(0, 600),
      model: 'raw',
      degraded: 'no_api_key',
    }));

    const { recordExchange } = require('../exchanges.cjs');

    const cwd = mkTmpProject();
    const sessionId = 'sess-degrade-456';
    const result = 'Some verbatim result text from the assistant.';

    await recordExchange({ sessionId, cwd, prompt: 'do something', result });

    const content = await fsp.readFile(exchangesLogPath(cwd), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);

    const record = JSON.parse(lines[0]);
    assert.equal(record.sessionId, sessionId);
    assert.equal(record.result, result, 'verbatim result must be stored');
    assert.equal(record.degraded, 'no_api_key');
    assert.equal(record.model, 'raw');
    // summary is the raw slice of the result
    assert.equal(record.summary, result.slice(0, 600));
  });

  test('appends multiple records to the same file', async () => {
    stubSummarize(async () => ({ summary: 'ok', model: 'claude-haiku-4-5' }));

    const { recordExchange } = require('../exchanges.cjs');

    const cwd = mkTmpProject();

    await recordExchange({ sessionId: 's1', cwd, prompt: 'first', result: 'res1' });
    await recordExchange({ sessionId: 's2', cwd, prompt: 'second', result: 'res2' });

    const content = await fsp.readFile(exchangesLogPath(cwd), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);

    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    assert.equal(r1.sessionId, 's1');
    assert.equal(r2.sessionId, 's2');
  });
});
