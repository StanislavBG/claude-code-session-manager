'use strict';
import { test, expect } from 'vitest';
const { detectSandboxEnvironmentLimit } = require('../sandboxEnvironmentLimit.cjs');

test('claude-dir-write', () => {
  const r = detectSandboxEnvironmentLimit('SCHEDULER_VERDICT: FAIL sandbox blocks writes under .claude/settings.json');
  expect(r.kind).toBe('claude-dir-write');
  expect(r.evidence).toContain('.claude');
});
test('unix-socket both orders', () => {
  expect(detectSandboxEnvironmentLimit('PermissionError: [Errno 1] Operation not permitted on socket(AF_UNIX)').kind).toBe('unix-socket');
  expect(detectSandboxEnvironmentLimit('socket(AF_UNIX) failed: Operation not permitted').kind).toBe('unix-socket');
});
test('readonly-tmp both orders', () => {
  expect(detectSandboxEnvironmentLimit("OSError: [Errno 30] Read-only file system: '/tmp/x'").kind).toBe('readonly-tmp');
  expect(detectSandboxEnvironmentLimit('cannot write /tmp/foo: Read-only file system').kind).toBe('readonly-tmp');
});
test('negatives', () => {
  expect(detectSandboxEnvironmentLimit("Error: EACCES: permission denied, open '/app/data.json'")).toBeNull();
  expect(detectSandboxEnvironmentLimit('the sandbox is a nice feature')).toBeNull();
  expect(detectSandboxEnvironmentLimit('Read-only file system: /etc/hosts')).toBeNull();
  expect(detectSandboxEnvironmentLimit('')).toBeNull();
  expect(detectSandboxEnvironmentLimit(null)).toBeNull();
});
