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

// ── sandboxLimitFromStreamJson ──
const { sandboxLimitFromStreamJson, environmentLimitStamp, ENVIRONMENT_LIMIT_MESSAGE } = require('../sandboxEnvironmentLimit.cjs');
const nodefs = require('node:fs');
const nodepath = require('node:path');
const j = (o) => JSON.stringify(o);
const bashUse = (id) => j({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });
const readUse = (id) => j({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } });
const toolRes = (id, content, is_error = true) => j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });

test('stream: PRD_AUTHORING sandbox section read via Read -> null', () => {
  const doc = nodefs.readFileSync(nodepath.join(__dirname, '../../../templates/PRD_AUTHORING.md'), 'utf8');
  const i = doc.indexOf('Job sandbox limits');
  expect(i).toBeGreaterThan(-1);
  const section = doc.slice(i, i + 3000);
  const log = [readUse('r1'), toolRes('r1', section, false)].join('\n');
  expect(sandboxLimitFromStreamJson(log)).toBeNull();
});
test('stream: Bash error tool_result -> unix-socket', () => {
  const log = [bashUse('b1'), toolRes('b1', [{ type: 'text', text: 'Traceback\nPermissionError: [Errno 1] Operation not permitted on socket(AF_UNIX)\n' }])].join('\n');
  expect(sandboxLimitFromStreamJson(log).kind).toBe('unix-socket');
});
test('stream: final result FAIL reason -> claude-dir-write', () => {
  const log = ['not json', j({ type: 'result', result: 'done\nSCHEDULER_VERDICT: FAIL sandbox blocks writes under .claude/skills, so the git mv could not run' })].join('\n');
  expect(sandboxLimitFromStreamJson(log).kind).toBe('claude-dir-write');
});
test('stream: assistant text quoting the strings -> null', () => {
  const log = j({ type: 'assistant', message: { content: [{ type: 'text', text: 'sandbox blocks writes under .claude/skills\nOperation not permitted socket(AF_UNIX)' }] } });
  expect(sandboxLimitFromStreamJson(log)).toBeNull();
});
test('environmentLimitStamp', () => {
  const lim = { kind: 'unix-socket', evidence: 'x' };
  expect(environmentLimitStamp(lim, 'failed')).toEqual({ environmentLimit: lim, error: ENVIRONMENT_LIMIT_MESSAGE });
  expect(environmentLimitStamp(lim, 'completed').environmentLimit).toBeNull();
  expect(environmentLimitStamp(null, 'failed').environmentLimit).toBeNull();
});

test('stream: successful Bash cat of the sandbox section -> null; is_error + AF_UNIX -> unix-socket', () => {
  const doc = nodefs.readFileSync(nodepath.join(__dirname, '../../../templates/PRD_AUTHORING.md'), 'utf8');
  const section = doc.slice(doc.indexOf('Job sandbox limits'), doc.indexOf('Job sandbox limits') + 3000);
  expect(sandboxLimitFromStreamJson([bashUse('b1'), toolRes('b1', section, false)].join('\n'))).toBeNull();
  const absent = j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: section }] } });
  expect(sandboxLimitFromStreamJson([bashUse('b1'), absent].join('\n'))).toBeNull();
  const err = section.split('\n').find((l) => l.includes('AF_UNIX')) + '\nPermissionError: [Errno 1] Operation not permitted on socket(AF_UNIX)\n';
  expect(sandboxLimitFromStreamJson([bashUse('b1'), toolRes('b1', err, true)].join('\n')).kind).toBe('unix-socket');
});
test('stream: structured_output FAIL failReason -> claude-dir-write', () => {
  const so = { schedulerVerdict: 'FAIL', failReason: 'sandbox blocks writes under .claude/skills' };
  for (const key of ['structured_output', 'structuredOutput']) {
    const log = j({ type: 'result', result: '{}', [key]: so });
    expect(sandboxLimitFromStreamJson(log).kind).toBe('claude-dir-write');
  }
});
test('claude-dir-write raw refusal', () => {
  const log = [bashUse('b1'), toolRes('b1', "mv: cannot move 'a' to '.claude/skills/b': Operation not permitted")].join('\n');
  expect(sandboxLimitFromStreamJson(log).kind).toBe('claude-dir-write');
  expect(sandboxLimitFromStreamJson([bashUse('b1'), toolRes('b1', 'Bash writes under .claude/ are refused')].join('\n'))).toBeNull();
  expect(sandboxLimitFromStreamJson([bashUse('b1'), toolRes('b1', 'cat: x: Permission denied')].join('\n'))).toBeNull();
});
