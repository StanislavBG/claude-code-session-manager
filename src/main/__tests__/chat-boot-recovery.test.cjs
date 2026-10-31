/**
 * chat-boot-recovery.test.cjs — boot recovery of in-flight chat turns.
 * Run: timeout 200 npx vitest run src/main/__tests__/chat-boot-recovery.test.cjs
 */
'use strict';

import { test, beforeEach, afterEach } from 'vitest';
const assert = require('node:assert/strict');
const { recoverInflightTurns, CONTINUE_PROMPT, DAY_MS } = require('../lib/chatBootRecovery.cjs');
const cr = require('../chatRunner.cjs');

const NOW = 1_800_000_000_000;
const tick = () => new Promise((r) => setImmediate(r));

function harness({ entries, alive = {}, tail = null, recovered = {}, ident } = {}) {
  const calls = { run: [], end: [], mark: [], notify: [], hold: [], release: [] };
  const timers = [];
  const deps = {
    ledger: {
      list: async () => entries,
      end: async (s) => { calls.end.push(s); },
      markRecovered: async (s, at) => { calls.mark.push([s, at]); recovered[s] = at; },
      recoveredMap: async () => recovered,
    },
    run: (o) => { calls.run.push(o); return { accepted: true }; },
    holdOrphan: (s) => calls.hold.push(s),
    releaseOrphan: (s) => calls.release.push(s),
    pidAlive: (pid) => !!alive[pid],
    identityOf: ident || ((pid) => ({ cmdline: `sm-claude-chat --resume ${entries.find((e) => e.pid === pid).sessionId}` })),
    readTranscriptTail: async () => tail,
    notify: (c, p) => calls.notify.push([c, p]),
    now: () => NOW,
    pollMs: 5,
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
  };
  return { deps, calls, timers, alive };
}
const entry = (o = {}) => ({ sessionId: 's1', tabId: 't1', cwd: '/p', pid: 100, resume: true, ...o });

test('orphan: holds session until pid exits, then re-runs once', async () => {
  const h = harness({ entries: [entry()], alive: { 100: true }, tail: { role: 'user' } });
  const { results, pending } = await recoverInflightTurns(h.deps);
  assert.deepEqual(h.calls.hold, ['s1']);
  assert.equal(h.calls.run.length, 0);
  assert.equal(results[0].outcome, 'orphan');
  h.timers.shift()(); // still alive
  await tick();
  assert.equal(h.calls.run.length, 0);
  h.alive[100] = false;
  h.timers.shift()();
  await pending;
  assert.equal(h.calls.run.length, 1);
  assert.deepEqual(h.calls.release, ['s1']);
});

test('orphan identity mismatch (recycled pid) is treated as dead', async () => {
  const h = harness({ entries: [entry()], alive: { 100: true }, tail: { role: 'user' }, ident: () => ({ cmdline: 'vim' }) });
  await recoverInflightTurns(h.deps);
  assert.equal(h.calls.hold.length, 0);
  assert.equal(h.calls.run.length, 1);
});

test('finished transcript only clears the entry and refreshes the tab', async () => {
  const h = harness({ entries: [entry()], tail: { role: 'assistant', text: 'done' } });
  const { results } = await recoverInflightTurns(h.deps);
  assert.equal(results[0].outcome, 'finished');
  assert.deepEqual(h.calls.end, ['s1']);
  assert.equal(h.calls.run.length, 0);
  assert.equal(h.calls.notify[0][1].tabId, 't1');
});

test('dead + unfinished re-runs once with same sessionId and continue prompt', async () => {
  const h = harness({ entries: [entry({ promptId: 'p9' })], tail: { role: 'user' } });
  await recoverInflightTurns(h.deps);
  assert.equal(h.calls.run.length, 1);
  const r = h.calls.run[0];
  assert.equal(r.sessionId, 's1');
  assert.equal(r.tabId, 't1');
  assert.equal(r.cwd, '/p');
  assert.equal(r.resume, true);
  assert.equal(r.promptId, 'p9');
  assert.equal(r.prompt, CONTINUE_PROMPT);
  assert.match(r.prompt, /restarted/);
  assert.match(r.prompt, /already landed/);
  assert.deepEqual(h.calls.mark, [['s1', NOW]]);
});

test('24h guard: a session recovered recently is not re-run', async () => {
  const h = harness({ entries: [entry()], tail: { role: 'user' }, recovered: { s1: NOW - DAY_MS + 60_000 } });
  const { results } = await recoverInflightTurns(h.deps);
  assert.equal(results[0].outcome, 'guarded');
  assert.equal(h.calls.run.length, 0);
  assert.deepEqual(h.calls.end, ['s1']);
  const h2 = harness({ entries: [entry()], tail: { role: 'user' }, recovered: { s1: NOW - DAY_MS - 1 } });
  await recoverInflightTurns(h2.deps);
  assert.equal(h2.calls.run.length, 1);
});

test('closed tab: re-run needs no renderer, notify failure is swallowed', async () => {
  const h = harness({ entries: [entry({ tabId: 'gone' })], tail: null });
  h.deps.notify = () => { throw new Error('window destroyed'); };
  const { results } = await recoverInflightTurns(h.deps);
  assert.equal(results[0].outcome, 'rerun');
  assert.equal(h.calls.run[0].tabId, 'gone');
});

test('chatRunner holds run() for an orphan session until released', async () => {
  process.env.SM_SESSION_SLOTS = '2';
  cr.__resetQueueForTests();
  const started = [];
  cr.__setExecutor((j) => { started.push(j.sessionId); return Promise.resolve(); });
  cr.holdOrphanSession('s1');
  cr.run({ tabId: 't1', sessionId: 's1', prompt: 'x', cwd: '/', resume: true });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(started, []);
  cr.releaseOrphanSession('s1');
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(started, ['s1']);
});

afterEach(() => { cr.__setExecutor(null); cr.__resetQueueForTests(); });
beforeEach(() => { cr.__resetQueueForTests(); });
