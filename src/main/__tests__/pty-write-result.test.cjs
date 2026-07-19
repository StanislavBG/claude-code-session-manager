/**
 * pty-write-result.test.cjs — unit tests for PtyManager.write()'s return contract.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/pty-write-result.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { manager } = require('../pty.cjs');

test('write to an existing session succeeds', () => {
  const tabId = 'tab-existing';
  const proc = { write: () => {} };
  manager.sessions.set(tabId, { proc, cwd: '/tmp', created: 0 });
  try {
    const result = manager.write({ tabId, data: 'hello' });
    expect(result).toEqual({ ok: true });
  } finally {
    manager.sessions.delete(tabId);
  }
});

test('write to a nonexistent tabId returns no-pty', () => {
  const result = manager.write({ tabId: 'tab-does-not-exist', data: 'hello' });
  expect(result).toEqual({ ok: false, reason: 'no-pty' });
});

test('write where proc.write throws returns the error reason without throwing', () => {
  const tabId = 'tab-throws';
  const proc = {
    write: () => {
      throw new Error('EPIPE: write after end');
    },
  };
  manager.sessions.set(tabId, { proc, cwd: '/tmp', created: 0 });
  try {
    let result;
    expect(() => {
      result = manager.write({ tabId, data: 'hello' });
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'EPIPE: write after end' });
  } finally {
    manager.sessions.delete(tabId);
  }
});
