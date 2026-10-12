/**
 * credentials-cli-refresh.test.cjs — the private OAuth grant (no client_id)
 * returned HTTP 403 on 1,112/1,112 attempts, and the 403 skipped the CLI
 * fallback. The CLI fallback is now the sole refresh avenue.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/credentials-cli-refresh.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const originalHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cred-cli-'));
process.env.HOME = tmpHome;

// credentials.cjs destructures `spawn` at require time, so patch before require.
const originalSpawn = childProcess.spawn;
let spawnCalls = 0;
let onSpawn = () => {};
childProcess.spawn = (...args) => {
  spawnCalls++;
  const child = new EventEmitter();
  setImmediate(() => { onSpawn(); child.emit('close', spawnExit); });
  return child;
};
let spawnExit = 0;

const { refreshIfNeeded } = require('../credentials.cjs');

const CREDS_FILE = path.join(tmpHome, '.claude', '.credentials.json');
const LOG_FILE = path.join(tmpHome, '.claude', 'session-manager', 'credential-refresh.log');

function writeCreds(oauth) {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
}
function events() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).event);
  } catch { return []; }
}

const fetchStub = vi.fn(() => { throw new Error('network fetch must not be used'); });
const originalFetch = global.fetch;

beforeEach(() => {
  try { fs.unlinkSync(CREDS_FILE); } catch { /* absent */ }
  try { fs.unlinkSync(LOG_FILE); } catch { /* absent */ }
  spawnCalls = 0;
  spawnExit = 0;
  onSpawn = () => {};
  fetchStub.mockClear();
  global.fetch = fetchStub;
});

afterAll(() => {
  childProcess.spawn = originalSpawn;
  global.fetch = originalFetch;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('an expiring token triggers the CLI fallback, never a network fetch, and returns the re-read creds', async () => {
  writeCreds({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 60_000 });
  // The CLI "refreshes" the file while it runs.
  onSpawn = () => writeCreds({ accessToken: 'new', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });

  const res = await refreshIfNeeded();

  expect(fetchStub).not.toHaveBeenCalled();
  expect(spawnCalls).toBe(1);
  expect(res.kind).toBe('ok');
  expect(res.creds.accessToken).toBe('new');
  expect(events()).toContain('cli_fallback_ok');
});

test('a failed CLI fallback on an expired token returns an auth verdict mentioning `claude`', async () => {
  writeCreds({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 60_000 });
  spawnExit = 1;

  const res = await refreshIfNeeded();

  expect(fetchStub).not.toHaveBeenCalled();
  expect(spawnCalls).toBe(1);
  expect(res.kind).toBe('auth');
  expect(res.message).toMatch(/claude/);
  expect(events()).toContain('cli_fallback_failed');
});
