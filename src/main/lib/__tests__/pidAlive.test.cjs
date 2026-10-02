/**
 * pidAlive.test.cjs — the single shared "is this pid alive" predicate now
 * reused by watchdogHelpers.cjs (isPidAlive), reservationExpiry.cjs
 * (defaultPidAlive), instanceLock.cjs (pidAlive), and reaperHelpers.cjs's
 * claudePidAlive existence check.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/pidAlive.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (CLAUDE.md).
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pidAlive } = require('../pidAlive.cjs');

test('invalid pid shapes are never alive', () => {
  assert.strictEqual(pidAlive(null), false);
  assert.strictEqual(pidAlive(undefined), false);
  assert.strictEqual(pidAlive(0), false);
  assert.strictEqual(pidAlive(1), false); // init/launchd — never a real target
  assert.strictEqual(pidAlive(-5), false);
  assert.strictEqual(pidAlive(1.5), false);
  assert.strictEqual(pidAlive('123'), false);
});

test('the running test process pid is alive', () => {
  assert.strictEqual(pidAlive(process.pid), true);
});

test('a pid whose process has already exited (ESRCH) is dead', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise((resolve) => child.on('exit', resolve));
  assert.strictEqual(pidAlive(pid), false);
});

test('EPERM (pid exists, owned by another user) counts as alive', () => {
  const original = process.kill;
  process.kill = () => {
    const e = new Error('EPERM');
    e.code = 'EPERM';
    throw e;
  };
  try {
    assert.strictEqual(pidAlive(2), true);
  } finally {
    process.kill = original;
  }
});

test('ESRCH (no such process) is dead', () => {
  const original = process.kill;
  process.kill = () => {
    const e = new Error('ESRCH');
    e.code = 'ESRCH';
    throw e;
  };
  try {
    assert.strictEqual(pidAlive(99999), false);
  } finally {
    process.kill = original;
  }
});
