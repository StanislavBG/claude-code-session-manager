/**
 * health-credentials.test.cjs — the credential health component.
 *
 * An expired/absent Claude OAuth token silently voids the whole scheduler:
 * headless `claude -p` jobs cannot authenticate, so the queue "runs" but
 * nothing completes. On this machine the token expired 2026-04-04 with no
 * refresh token, yet `npm run health` read GREEN — no component pointed the
 * operator at `claude login`. evaluateCredentialHealth is the missing signal.
 * Pure over an injected credState (the shape refreshIfNeeded returns), so no
 * Keychain access here.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-credentials.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { evaluateCredentialHealth } = require('../health.cjs');

const NOW = Date.parse('2026-09-23T15:00:00.000Z');

test('an expired token is not ok, names claude login, and reports how long ago it lapsed', () => {
  const expiredAt = NOW - 90 * 60_000; // 90 min ago
  const { component, issues } = evaluateCredentialHealth({
    credState: { kind: 'auth', message: 'Credentials expired.', expiredAt },
    now: NOW,
  });
  expect(component.ok).toBe(false);
  expect(component.state).toBe('expired');
  expect(component.expiredAt).toBe(expiredAt);
  expect(component.message).toMatch(/claude login/);
  expect(component.message).toMatch(/90m ago/);
  expect(issues.length).toBe(1);
  expect(issues[0]).toMatch(/cannot authenticate/i);
});

test('an auth failure with no expiredAt still fails and still names the fix', () => {
  const { component, issues } = evaluateCredentialHealth({
    credState: { kind: 'auth', message: 'refresh rejected: HTTP 401' },
    now: NOW,
  });
  expect(component.ok).toBe(false);
  expect(component.state).toBe('expired');
  expect(component.message).toMatch(/claude login/);
  expect(component.message).not.toMatch(/NaN/);
  expect(issues.length).toBe(1);
});

test('unreadable/absent credentials (kind:config) fail with the login fix', () => {
  const { component, issues } = evaluateCredentialHealth({
    credState: { kind: 'config', message: 'credentials not found' },
    now: NOW,
  });
  expect(component.ok).toBe(false);
  expect(component.state).toBe('unreadable');
  expect(component.message).toMatch(/claude login/);
  expect(issues.length).toBe(1);
});

test('a fresh token is ok and raises no issue', () => {
  const { component, issues } = evaluateCredentialHealth({ credState: { kind: 'ok' }, now: NOW });
  expect(component.ok).toBe(true);
  expect(component.state).toBe('valid');
  expect(issues.length).toBe(0);
});

test('kind:unsupported (auto-refresh unavailable, token still valid) is ok — the token works, refresh just can not', () => {
  const { component, issues } = evaluateCredentialHealth({ credState: { kind: 'unsupported' }, now: NOW });
  expect(component.ok).toBe(true);
  expect(component.state).toBe('valid-no-refresh');
  expect(issues.length).toBe(0);
});

test('a missing/garbage credState never throws and never fails health (unknown, not a false alarm)', () => {
  for (const bad of [undefined, null, 'nope', 42]) {
    const { component, issues } = evaluateCredentialHealth({ credState: bad, now: NOW });
    expect(component.ok).toBe(true);
    expect(component.state).toBe('unknown');
    expect(issues.length).toBe(0);
  }
});
