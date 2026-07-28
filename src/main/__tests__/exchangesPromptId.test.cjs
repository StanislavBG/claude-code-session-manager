/**
 * exchangesPromptId.test.cjs — recordExchange() round-trips the optional
 * promptId field (PRD 749). Separate file from exchanges.test.cjs (which
 * runs under node:test, not vitest) so this is picked up by
 * `npx vitest run` per this repo's test:unit convention.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/exchangesPromptId.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let tmpHome;
let origHome;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exchanges-promptid-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // Stub summarize.cjs to avoid any network calls, and clear the modules
  // that cache HOME-derived paths so each test sees the tmp HOME.
  const summarizePath = require.resolve('../lib/summarize.cjs');
  delete require.cache[summarizePath];
  require.cache[summarizePath] = {
    id: summarizePath,
    filename: summarizePath,
    loaded: true,
    exports: { summarize: async () => ({ summary: 'ok', model: 'claude-haiku-4-5' }) },
  };
  delete require.cache[require.resolve('../exchanges.cjs')];
  delete require.cache[require.resolve('../config.cjs')];
  delete require.cache[require.resolve('../lib/encodeCwd.cjs')];
});

test('recordExchange persists promptId when supplied', async () => {
  const { recordExchange } = require('../exchanges.cjs');
  const { encodeCwd } = require('../lib/encodeCwd.cjs');

  const cwd = '/home/user/promptid-project';
  await recordExchange({ sessionId: 's1', cwd, prompt: 'do X', result: 'done', promptId: 'ticket-abc-123' });

  const logPath = path.join(tmpHome, '.claude', 'knowledge-log', 'exchanges', `${encodeCwd(cwd)}.jsonl`);
  const record = JSON.parse((await fsp.readFile(logPath, 'utf8')).trim());
  expect(record.promptId).toBe('ticket-abc-123');
});

test('recordExchange omits promptId when not supplied (no backfill/synthesis)', async () => {
  const { recordExchange } = require('../exchanges.cjs');
  const { encodeCwd } = require('../lib/encodeCwd.cjs');

  const cwd = '/home/user/no-promptid-project';
  await recordExchange({ sessionId: 's2', cwd, prompt: 'do Y', result: 'done' });

  const logPath = path.join(tmpHome, '.claude', 'knowledge-log', 'exchanges', `${encodeCwd(cwd)}.jsonl`);
  const record = JSON.parse((await fsp.readFile(logPath, 'utf8')).trim());
  expect('promptId' in record).toBe(false);
});
