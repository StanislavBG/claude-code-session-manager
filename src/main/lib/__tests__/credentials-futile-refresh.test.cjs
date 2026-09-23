/**
 * credentials-futile-refresh.test.cjs — the 2026-09-23 credential-refresh
 * storm. On this machine the OAuth creds were expired with NO refresh token
 * (expiredAtMs 1775277875159). Every 15 s billing poll called refreshIfNeeded,
 * which tried the OAuth grant (instant 'unsupported' — no refresh token),
 * then spawned `claude --version` as a CLI fallback (which shares the same
 * missing token, so it can't help either), then logged auth_failed_expired —
 * the identical triple, forever, spawning a doomed child process each time.
 *
 * The fix: a futile-refresh short-circuit. When the token is expired AND has
 * no refresh token, refreshIfNeeded re-reads once (to catch an out-of-band
 * `claude login`) and otherwise returns the auth verdict WITHOUT the OAuth
 * call or the CLI-fallback spawn, logging at most once per cooldown window.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/credentials-futile-refresh.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// credentials.cjs freezes CREDS_PATH and REFRESH_LOG_PATH from os.homedir() at
// require time. os.homedir() honors $HOME on POSIX, so point HOME at a temp
// dir BEFORE the require (not in beforeEach — that runs too late) so both the
// creds file we write and the log the code writes resolve under our sandbox.
const originalHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cred-futile-'));
process.env.HOME = tmpHome;

const credentials = require('../credentials.cjs');
const { isRefreshFutile, refreshIfNeeded, __resetFutileRefreshThrottle } = credentials;

const CREDS_FILE = path.join(tmpHome, '.claude', '.credentials.json');
const LOG_FILE = path.join(tmpHome, '.claude', 'session-manager', 'credential-refresh.log');

function writeCreds(oauth) {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
}

function readLogLines() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeEach(() => {
  // Clean slate per test: no stale creds file, no carried-over log or throttle.
  try { fs.unlinkSync(CREDS_FILE); } catch { /* absent */ }
  try { fs.unlinkSync(LOG_FILE); } catch { /* absent */ }
  __resetFutileRefreshThrottle();
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('isRefreshFutile: expired + no refresh token is futile; anything else is not', () => {
  const past = Date.now() - 60_000;
  const future = Date.now() + 60 * 60_000;
  expect(isRefreshFutile({ accessToken: 'a', expiresAt: past })).toBe(true);
  // Has a refresh token → OAuth grant is worth attempting, not futile.
  expect(isRefreshFutile({ accessToken: 'a', expiresAt: past, refreshToken: 'r' })).toBe(false);
  // Not expired → not futile even without a refresh token.
  expect(isRefreshFutile({ accessToken: 'a', expiresAt: future })).toBe(false);
});

test('a futile refresh returns an auth verdict without spawning the CLI fallback, and logs the no-refresh-token event once', async () => {
  writeCreds({ accessToken: 'expired', expiresAt: Date.now() - 60_000 }); // expired, no refreshToken

  const res = await refreshIfNeeded();

  expect(res.kind).toBe('auth');
  expect(res.message).toMatch(/no refresh token/i);
  expect(typeof res.expiredAt).toBe('number');

  const events = readLogLines().map((e) => e.event);
  // The distinctive no-refresh-token event fires...
  expect(events).toContain('auth_failed_expired_no_refresh_token');
  // ...and the storm's spawn/oauth triple never runs.
  expect(events).not.toContain('cli_fallback_ok');
  expect(events).not.toContain('cli_fallback_failed');
  expect(events).not.toContain('oauth_refresh_unsupported');
});

test('repeated polls in the cooldown window do NOT re-log — the every-15s storm is suppressed', async () => {
  writeCreds({ accessToken: 'expired', expiresAt: Date.now() - 60_000 });

  // Simulate several poll cycles back-to-back (as pollLoop would, every 15 s).
  for (let i = 0; i < 5; i++) {
    const res = await refreshIfNeeded();
    expect(res.kind).toBe('auth');
  }

  const futileLogs = readLogLines().filter((e) => e.event === 'auth_failed_expired_no_refresh_token');
  expect(futileLogs.length).toBe(1); // once, not five times
});

test('an out-of-band `claude login` (fresh creds on disk) is picked up on the next call', async () => {
  writeCreds({ accessToken: 'expired', expiresAt: Date.now() - 60_000 });
  expect((await refreshIfNeeded()).kind).toBe('auth');

  // User runs `claude` in a terminal → fresh creds land on disk.
  writeCreds({ accessToken: 'fresh', expiresAt: Date.now() + 60 * 60_000 });

  const res = await refreshIfNeeded();
  expect(res.kind).toBe('ok');
  expect(res.creds.accessToken).toBe('fresh');
});
