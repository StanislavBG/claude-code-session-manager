/**
 * leftoverRenice.test.cjs — leftover chat/aux processes (CLAUDE_PID gone) go
 * to nice 19; live turns, other users and unroled processes are untouched.
 *
 * Run: timeout 120 npx vitest run src/main/lib/process/__tests__/leftoverRenice.test.cjs
 */

'use strict';

import { test, beforeEach, afterEach } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findLeftovers, reniceLeftovers, parseEnviron, MAX_SCAN } = require('../leftoverRenice.cjs');

const UID = 1000;
let root;

/** Write one fake /proc/<pid> entry. */
function proc(pid, { uid = UID, env = {} } = {}) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status'), `Name:\tpython\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  const environ = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
  fs.writeFileSync(path.join(dir, 'environ'), `PATH=/usr/bin\0${environ}`);
}

function spyOpts(extra = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    opts: {
      procRoot: root,
      uid: UID,
      selfPid: 1,
      setPriority: (pid, prio) => calls.push([pid, prio]),
      getPriority: () => 12,
      log: (m) => logs.push(m),
      seen: new Set(),
      appClaudePid: null,
      ...extra,
    },
  };
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-proc-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('a chat process whose CLAUDE_PID is gone is reniced to 19 and logged once', () => {
  // Evidence shape: SM_PROC_ROLE=chat, CLAUDE_PID=2858266 gone.
  proc(2893850, { env: { SM_PROC_ROLE: 'chat', CLAUDE_PID: '2858266' } });
  const s = spyOpts();
  assert.deepStrictEqual(findLeftovers({ procRoot: root, uid: UID, selfPid: 1 }).map((l) => l.pid), [2893850]);
  assert.deepStrictEqual(reniceLeftovers(s.opts), [2893850]);
  assert.deepStrictEqual(s.calls, [[2893850, 19]]);
  reniceLeftovers(s.opts);
  assert.strictEqual(s.logs.length, 1);
  assert.match(s.logs[0], /2893850/);
});

test('aux role counts too; an already-idle process is not set again', () => {
  proc(500, { env: { SM_PROC_ROLE: 'aux', CLAUDE_PID: '9999' } });
  const s = spyOpts({ getPriority: () => 19 });
  assert.deepStrictEqual(reniceLeftovers(s.opts), []);
  assert.deepStrictEqual(s.calls, []);
  assert.strictEqual(s.logs.length, 1);
});

test('a process of a live turn (CLAUDE_PID alive) is never touched', () => {
  proc(4000, { env: { SM_PROC_ROLE: 'chat' } }); // the live claude itself
  proc(4001, { env: { SM_PROC_ROLE: 'chat', CLAUDE_PID: '4000' } });
  const s = spyOpts();
  assert.deepStrictEqual(reniceLeftovers(s.opts), []);
  assert.deepStrictEqual(s.calls, []);
  assert.deepStrictEqual(s.logs, []);
});

test('another user\'s process is never touched', () => {
  proc(600, { uid: 0, env: { SM_PROC_ROLE: 'chat', CLAUDE_PID: '9999' } });
  const s = spyOpts();
  assert.deepStrictEqual(reniceLeftovers(s.opts), []);
  assert.deepStrictEqual(s.calls, []);
});

test('processes without SM_PROC_ROLE, or with another role, are never touched', () => {
  proc(700, { env: { CLAUDE_PID: '9999' } });
  proc(701, { env: { SM_PROC_ROLE: 'job', CLAUDE_PID: '9999' } });
  proc(702, { env: { SM_PROC_ROLE: 'shell', CLAUDE_PID: '9999' } });
  proc(703, { env: { SM_PROC_ROLE: 'chat' } }); // no CLAUDE_PID: nothing to judge by
  const s = spyOpts();
  assert.deepStrictEqual(reniceLeftovers(s.opts), []);
  assert.deepStrictEqual(s.calls, []);
});

test('unreadable entries are skipped and the scan never throws', () => {
  fs.mkdirSync(path.join(root, '800')); // no status/environ
  proc(801, { env: { SM_PROC_ROLE: 'chat', CLAUDE_PID: '9999' } });
  fs.mkdirSync(path.join(root, 'self'));
  const s = spyOpts();
  assert.deepStrictEqual(reniceLeftovers(s.opts), [801]);
  // Missing /proc root, throwing readdir, throwing setPriority.
  assert.deepStrictEqual(findLeftovers({ procRoot: path.join(root, 'nope'), uid: UID }), []);
  assert.deepStrictEqual(findLeftovers({ procRoot: root, uid: UID, readdir: () => { throw new Error('x'); } }), []);
  const t = spyOpts({ setPriority: () => { throw new Error('ESRCH'); } });
  assert.doesNotThrow(() => reniceLeftovers(t.opts));
});

test('a scan reads at most 4000 pids', () => {
  assert.strictEqual(MAX_SCAN, 4000);
  const names = Array.from({ length: 5000 }, (_, i) => String(i + 2));
  let statusReads = 0;
  const found = findLeftovers({
    procRoot: '/fake',
    uid: UID,
    selfPid: 1,
    readdir: () => names,
    readFile: (p) => {
      if (p.endsWith('status')) { statusReads += 1; return `Uid:\t${UID}\n`; }
      return 'SM_PROC_ROLE=chat\0CLAUDE_PID=99999\0';
    },
    isAlive: () => false,
  });
  assert.strictEqual(statusReads, 4000);
  assert.strictEqual(found.length, 4000);
});

test('reniceLeftovers never sends a signal', () => {
  proc(900, { env: { SM_PROC_ROLE: 'chat', CLAUDE_PID: '9999' } });
  const original = process.kill;
  const kills = [];
  process.kill = (...a) => { kills.push(a); return true; };
  try {
    reniceLeftovers(spyOpts().opts);
  } finally {
    process.kill = original;
  }
  assert.deepStrictEqual(kills, []);
});

test('parseEnviron reads only the two keys', () => {
  assert.deepStrictEqual(parseEnviron('A=1\0SM_PROC_ROLE=chat\0CLAUDE_PID=42\0B=2'), { role: 'chat', claudePid: 42 });
  assert.deepStrictEqual(parseEnviron('CLAUDE_PID=abc'), { role: null, claudePid: null });
});

test('a process carrying the app\'s own inherited CLAUDE_PID is never touched', () => {
  // App started from inside a claude session (CLAUDE_PID 111, since gone):
  // every chat process inherits 111, so 111 says nothing about the turn.
  proc(1100, { env: { SM_PROC_ROLE: 'chat', CLAUDE_PID: '111' } });
  proc(1101, { env: { SM_PROC_ROLE: 'chat', CLAUDE_PID: '222' } });
  const s = spyOpts({ appClaudePid: 111 });
  assert.deepStrictEqual(findLeftovers({ procRoot: root, uid: UID, selfPid: 1, appClaudePid: 111 }).map((l) => l.pid), [1101]);
  assert.deepStrictEqual(reniceLeftovers(s.opts), [1101]);
  assert.deepStrictEqual(s.calls, [[1101, 19]]);
});
