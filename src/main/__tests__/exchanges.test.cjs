'use strict';

/**
 * Unit test for exchanges.cjs.
 *
 * Runs against a tmp HOME so no real files are touched.
 * Stubs summarize.cjs to avoid any network calls.
 *
 * Run: timeout 120 node --test src/main/__tests__/exchanges.test.cjs
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// ─── Tmp HOME setup ─────────────────────────────────────────────────────────

let tmpHome;
let origHome;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exchanges-test-'));
  origHome = process.env.HOME;
  // node:os.homedir() reads HOME on Linux
  process.env.HOME = tmpHome;
});

after(async () => {
  process.env.HOME = origHome;
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

// ─── Module loading under tmp HOME ──────────────────────────────────────────

// Clear module cache so encodeCwd / config / exchanges pick up the new HOME
function freshRequire(mod) {
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('recordExchange', () => {
  test('writes a complete record when summarize succeeds', async () => {
    // Stub summarize to return a fixed summary without a network call
    const summarizePath = require.resolve('../lib/summarize.cjs');
    delete require.cache[summarizePath];
    require.cache[summarizePath] = {
      id: summarizePath,
      filename: summarizePath,
      loaded: true,
      exports: {
        summarize: async () => ({ summary: 'Test summary.', model: 'claude-haiku-4-5' }),
      },
    };

    // Clear exchanges so it picks up the stub
    const exchangesPath = require.resolve('../exchanges.cjs');
    delete require.cache[exchangesPath];
    // Also clear config so it re-reads the new HOME
    const configPath = require.resolve('../config.cjs');
    delete require.cache[configPath];
    const encodeCwdPath = require.resolve('../lib/encodeCwd.cjs');
    delete require.cache[encodeCwdPath];

    const { recordExchange, EXCHANGES_DIR } = require('../exchanges.cjs');

    const sessionId = 'sess-abc-123';
    const cwd = '/home/user/myproject';
    const prompt = 'What is 2+2?';
    const result = 'The answer is 4.';

    await recordExchange({ sessionId, cwd, prompt, result });

    // Re-resolve the exchanges dir using the actual module's path (under tmpHome)
    const { encodeCwd } = require('../lib/encodeCwd.cjs');
    const encoded = encodeCwd(cwd);
    const logPath = path.join(tmpHome, '.claude', 'knowledge-log', 'exchanges', `${encoded}.jsonl`);

    const content = await fsp.readFile(logPath, 'utf8');
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
    // Stub summarize to return a degraded result
    const summarizePath = require.resolve('../lib/summarize.cjs');
    delete require.cache[summarizePath];
    require.cache[summarizePath] = {
      id: summarizePath,
      filename: summarizePath,
      loaded: true,
      exports: {
        summarize: async (text) => ({
          summary: text.slice(0, 600),
          model: 'raw',
          degraded: 'no_api_key',
        }),
      },
    };

    const exchangesPath = require.resolve('../exchanges.cjs');
    delete require.cache[exchangesPath];

    const { recordExchange } = require('../exchanges.cjs');
    const { encodeCwd } = require('../lib/encodeCwd.cjs');

    const sessionId = 'sess-degrade-456';
    const cwd = '/home/user/anotherproject';
    const result = 'Some verbatim result text from the assistant.';

    await recordExchange({ sessionId, cwd, prompt: 'do something', result });

    const encoded = encodeCwd(cwd);
    const logPath = path.join(tmpHome, '.claude', 'knowledge-log', 'exchanges', `${encoded}.jsonl`);

    const content = await fsp.readFile(logPath, 'utf8');
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
    // Stub summarize
    const summarizePath = require.resolve('../lib/summarize.cjs');
    delete require.cache[summarizePath];
    require.cache[summarizePath] = {
      id: summarizePath,
      filename: summarizePath,
      loaded: true,
      exports: {
        summarize: async () => ({ summary: 'ok', model: 'claude-haiku-4-5' }),
      },
    };

    const exchangesPath = require.resolve('../exchanges.cjs');
    delete require.cache[exchangesPath];
    const { recordExchange } = require('../exchanges.cjs');
    const { encodeCwd } = require('../lib/encodeCwd.cjs');

    const cwd = '/home/user/multiproject';

    await recordExchange({ sessionId: 's1', cwd, prompt: 'first', result: 'res1' });
    await recordExchange({ sessionId: 's2', cwd, prompt: 'second', result: 'res2' });

    const encoded = encodeCwd(cwd);
    const logPath = path.join(tmpHome, '.claude', 'knowledge-log', 'exchanges', `${encoded}.jsonl`);
    const content = await fsp.readFile(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);

    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    assert.equal(r1.sessionId, 's1');
    assert.equal(r2.sessionId, 's2');
  });
});
