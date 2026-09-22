/**
 * exchangesPromptId.test.cjs — recordExchange() round-trips the optional
 * promptId field (PRD 749). Separate file from exchanges.test.cjs (which
 * runs under node:test, not vitest) so this is picked up by
 * `npx vitest run` per this repo's test:unit convention.
 *
 * PRD 1391: exchanges now write to <cwd>/session-manager-operations/
 * prompt-sessions/exchanges.jsonl — each test uses a fresh tmp directory as
 * its project `cwd`.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/exchangesPromptId.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exchanges-promptid-test-'));
}

function exchangesLogPath(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'exchanges.jsonl');
}

beforeEach(() => {
  // Stub summarize.cjs to avoid any network calls.
  const summarizePath = require.resolve('../lib/summarize.cjs');
  delete require.cache[summarizePath];
  require.cache[summarizePath] = {
    id: summarizePath,
    filename: summarizePath,
    loaded: true,
    exports: { summarize: async () => ({ summary: 'ok', model: 'claude-haiku-4-5' }) },
  };
  delete require.cache[require.resolve('../exchanges.cjs')];
});

test('recordExchange persists promptId when supplied', async () => {
  const { recordExchange } = require('../exchanges.cjs');

  const cwd = mkTmpProject();
  await recordExchange({ sessionId: 's1', cwd, prompt: 'do X', result: 'done', promptId: 'ticket-abc-123' });

  const record = JSON.parse((await fsp.readFile(exchangesLogPath(cwd), 'utf8')).trim());
  expect(record.promptId).toBe('ticket-abc-123');
});

test('recordExchange omits promptId when not supplied (no backfill/synthesis)', async () => {
  const { recordExchange } = require('../exchanges.cjs');

  const cwd = mkTmpProject();
  await recordExchange({ sessionId: 's2', cwd, prompt: 'do Y', result: 'done' });

  const record = JSON.parse((await fsp.readFile(exchangesLogPath(cwd), 'utf8')).trim());
  expect('promptId' in record).toBe(false);
});
