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

// ── multi-line tracebacks (traceback-block scan) ──
// Fixtures: verbatim stdout/stderr of `python3 -I <script>` (CPython 3.12.3) run inside a job sandbox.
const TB_SOCKET = `Traceback (most recent call last):
  File "/tmp/smj-kFldD2/claude-1000/a.py", line 2, in <module>
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.12/socket.py", line 233, in __init__
    _socket.socket.__init__(self, family, type, proto, fileno)
PermissionError: [Errno 1] Operation not permitted
`;
// Script: socket(AF_UNIX) then s.bind('x.sock'); the sandbox refuses at socket() so bind() is never reached,
// and the real traceback is the one below (line 2, the socket() call).
const TB_BIND = `Traceback (most recent call last):
  File "/tmp/smj-kFldD2/claude-1000/b.py", line 2, in <module>
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.12/socket.py", line 233, in __init__
    _socket.socket.__init__(self, family, type, proto, fileno)
PermissionError: [Errno 1] Operation not permitted
`;
const TB_TMP = `Traceback (most recent call last):
  File "/tmp/smj-kFldD2/claude-1000/c.py", line 1, in <module>
    open('/tmp/x_sm4727','w')
OSError: [Errno 30] Read-only file system: '/tmp/x_sm4727'
`;
const TB_EPERM = `Traceback (most recent call last):
  File "/tmp/smj-kFldD2/claude-1000/d.py", line 2, in <module>
    os.setgroups([0])
PermissionError: [Errno 1] Operation not permitted
`;
const stream = (body, is_error = true) => [bashUse('b1'), toolRes('b1', body, is_error)].join('\n');
test('stream: verbatim socket(AF_UNIX) and bind() tracebacks -> unix-socket', () => {
  expect(sandboxLimitFromStreamJson(stream(TB_SOCKET)).kind).toBe('unix-socket');
  expect(sandboxLimitFromStreamJson(stream(TB_BIND)).kind).toBe('unix-socket');
});
test('stream: verbatim open(/tmp) Errno 30 traceback -> readonly-tmp', () => {
  expect(sandboxLimitFromStreamJson(stream(TB_TMP)).kind).toBe('readonly-tmp');
});
test('stream: Operation not permitted without AF_UNIX in block -> null; earlier separate block does not count', () => {
  expect(sandboxLimitFromStreamJson(stream(TB_EPERM))).toBeNull();
  const earlier = 'x = socket.AF_UNIX\n' + TB_EPERM;
  expect(sandboxLimitFromStreamJson(stream(earlier))).toBeNull();
  const sepBlocks = TB_SOCKET.replace('PermissionError: [Errno 1] Operation not permitted', 'ValueError: nope') + TB_EPERM;
  expect(sandboxLimitFromStreamJson(stream(sepBlocks))).toBeNull();
});
test('stream: FAIL-reason path is plain per-line (no block scan)', () => {
  const reason = 'SCHEDULER_VERDICT: FAIL socket.AF_UNIX\nPermissionError: [Errno 1] Operation not permitted';
  expect(sandboxLimitFromStreamJson(j({ type: 'result', result: reason }))).toBeNull();
  expect(sandboxLimitFromStreamJson(j({ type: 'result', result: 'SCHEDULER_VERDICT: FAIL Operation not permitted on socket(AF_UNIX)' })).kind).toBe('unix-socket');
});
test('stream: AF_UNIX and errno >3 lines apart -> null; success and Read -> null', () => {
  const far = 'socket.AF_UNIX\na\nb\nc\nPermissionError: [Errno 1] Operation not permitted\n';
  expect(sandboxLimitFromStreamJson([bashUse('b1'), toolRes('b1', far)].join('\n'))).toBeNull();
  const adj = 'socket.AF_UNIX\nPermissionError: [Errno 1] Operation not permitted\n';
  expect(sandboxLimitFromStreamJson([bashUse('b1'), toolRes('b1', adj, false)].join('\n'))).toBeNull();
  expect(sandboxLimitFromStreamJson([readUse('r1'), toolRes('r1', adj)].join('\n'))).toBeNull();
});
test('stream: AF_UNIX traceback ending in ValueError, then plain rm EPERM -> null', () => {
  const body = TB_SOCKET.replace('PermissionError: [Errno 1] Operation not permitted', 'ValueError: nope')
    + "rm: cannot remove y: Operation not permitted\n";
  expect(sandboxLimitFromStreamJson(stream(body))).toBeNull();
});
test('stream: chained tracebacks still classify (new header opens fresh block)', () => {
  const chained = TB_SOCKET.replace('PermissionError: [Errno 1] Operation not permitted', 'KeyError: 1')
    + '\nDuring handling of the above exception, another exception occurred:\n\n' + TB_SOCKET;
  expect(sandboxLimitFromStreamJson(stream(chained)).kind).toBe('unix-socket');
});
