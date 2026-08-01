/**
 * opsErrorLog.test.cjs — appendError() is the sole writer of the `logs` ops
 * namespace (single-writer law, opsOwnership.cjs). Verifies: writes a tagged
 * JSONL line to <cwd>/session-manager-operations/logs/errors-<date>.jsonl,
 * redacts sensitive meta keys, and no-ops (never throws) with no cwd.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/opsErrorLog.test.cjs
 */

'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const opsErrorLog = require('../lib/opsErrorLog.cjs');

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-opslog-test-'));
}

function readLines(cwd) {
  const dir = opsErrorLog.logsDir(cwd);
  const file = opsErrorLog.todayFile(cwd);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('appendError writes a tagged JSONL line', () => {
  const cwd = mkTmpProject();
  opsErrorLog.appendError({
    cwd,
    scope: 'pty',
    tabId: 'tab-123',
    tags: ['spawn-failed'],
    message: 'pty.spawn threw: boom',
  });
  const lines = readLines(cwd);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.level, 'error');
  assert.equal(line.scope, 'pty');
  assert.equal(line.tabId, 'tab-123');
  assert.equal(line.message, 'pty.spawn threw: boom');
  assert.ok(line.tags.includes('level:error'));
  assert.ok(line.tags.includes('scope:pty'));
  assert.ok(line.tags.includes('tab:tab-123'));
  assert.ok(line.tags.includes('spawn-failed'));
  assert.ok(typeof line.ts === 'string' && !Number.isNaN(Date.parse(line.ts)));
});

test('appendError redacts sensitive meta keys', () => {
  const cwd = mkTmpProject();
  opsErrorLog.appendError({
    cwd,
    scope: 'chatRunner',
    message: 'run failed',
    meta: { token: 'sk-secret', sessionId: 'abc', password: 'hunter2' },
  });
  const [line] = readLines(cwd);
  assert.equal(line.meta.token, '[redacted]');
  assert.equal(line.meta.password, '[redacted]');
  assert.equal(line.meta.sessionId, 'abc');
});

test('appendError is a no-op with no cwd', () => {
  // Must not throw, and there is nowhere to assert a file was NOT written
  // since no cwd means no path — this just proves it never throws.
  assert.doesNotThrow(() => opsErrorLog.appendError({ scope: 'x', message: 'y' }));
});

test('appendError merges caller tags without duplicating auto-derived ones', () => {
  const cwd = mkTmpProject();
  opsErrorLog.appendError({
    cwd,
    scope: 'chatRunner',
    tabId: 'tab-9',
    tags: ['level:error', 'silent-probe'], // deliberately duplicates an auto tag
    message: 'probe failed',
  });
  const [line] = readLines(cwd);
  const count = line.tags.filter((t) => t === 'level:error').length;
  assert.equal(count, 1);
  assert.ok(line.tags.includes('silent-probe'));
});
