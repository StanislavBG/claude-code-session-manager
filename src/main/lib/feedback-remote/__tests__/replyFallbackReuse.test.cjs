/**
 * replyFallbackReuse.test.cjs — openReplyFallbackSession is idempotent per
 * thread: at most one OPEN (proposed/active) fallback Epic per
 * (asking Epic, replier Epic) pair.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/replyFallbackReuse.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { opsPath } = require('../../opsOwnership.cjs');
const { openReplyFallbackSession } = require('../crossProjectFeedback.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkProject(prefix) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), `sm-xfallback-${prefix}-`));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  return fs.realpathSync(cwd);
}

function indexFile(cwd) {
  return opsPath(cwd, 'prompt-sessions', 'active-index.json');
}

function readIndex(cwd) {
  try { return JSON.parse(fs.readFileSync(indexFile(cwd), 'utf8')); } catch { return { sessions: {}, events: {} }; }
}

function writeIndex(cwd, index) {
  const file = indexFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index));
}

function setStatus(cwd, epicId, status) {
  const idx = readIndex(cwd);
  idx.sessions[epicId].status = status;
  writeIndex(cwd, idx);
}

/** Fake mint: records the call and writes the session row into the active index. */
function makeHarness() {
  const calls = [];
  const audits = [];
  let n = 0;
  const ensureEpic = async (cwd, opts) => {
    n += 1;
    const epicId = `psess-fallback-${n}`;
    calls.push({ cwd, opts, epicId });
    const idx = readIndex(cwd);
    idx.sessions = idx.sessions || {};
    idx.sessions[epicId] = { id: epicId, cwd, status: opts.status, goalText: opts.goalText, source: opts.source };
    writeIndex(cwd, idx);
    return { epicId, prdDir: path.join(cwd, 'x'), created: true };
  };
  const appendAudit = (kind, payload) => audits.push({ kind, payload });
  return { calls, audits, deps: { ensureEpic, appendAudit } };
}

async function setup() {
  const a = await mkProject('a');
  const b = await mkProject('b');
  writeIndex(a, { sessions: {}, events: {} });
  const input = (over = {}) => ({
    reason: 'missing',
    toCwd: a,
    toEpicId: 'psess-x',
    fromCwd: b,
    fromEpicId: 'psess-y',
    message: 'Done — shipped.',
    outcome: 'done',
    original: { title: 'Start a macro from a script' },
    ...over,
  });
  return { a, b, input };
}

test('second reply on the same thread reuses the open fallback Epic and mints once', async () => {
  const { a, b, input } = await setup();
  const h = makeHarness();
  const first = await openReplyFallbackSession(input({ outcome: 'blocked' }), h.deps);
  expect(first.ok).toBe(true);
  expect(first.reused).toBeUndefined();
  const second = await openReplyFallbackSession(input({ outcome: 'done' }), h.deps);
  expect(second).toMatchObject({ ok: true, epicId: first.epicId, reused: true, status: 'proposed' });
  expect(h.calls).toHaveLength(1);

  expect(h.audits.map((x) => x.kind)).toEqual([
    'epic_cross_project_reply_fallback',
    'epic_cross_project_reply_fallback_reused',
  ]);
  expect(h.audits[1].payload).toEqual({
    cwd: a,
    epicId: first.epicId,
    replyOf: { cwd: a, epicId: 'psess-x' },
    fromCwd: b,
    fromEpicId: 'psess-y',
    outcome: 'done',
    reason: 'missing',
  });

  // An active fallback Epic is still open → still reused, status reported.
  setStatus(a, first.epicId, 'active');
  const third = await openReplyFallbackSession(input(), h.deps);
  expect(third).toMatchObject({ ok: true, epicId: first.epicId, reused: true, status: 'active' });
  expect(h.calls).toHaveLength(1);
});

test('a completed earlier fallback Epic is not reused — a new one is minted', async () => {
  const { a, input } = await setup();
  const h = makeHarness();
  const first = await openReplyFallbackSession(input(), h.deps);
  setStatus(a, first.epicId, 'completed');
  const second = await openReplyFallbackSession(input(), h.deps);
  expect(second.ok).toBe(true);
  expect(second.reused).toBeUndefined();
  expect(second.epicId).not.toBe(first.epicId);
  expect(h.calls).toHaveLength(2);
  expect(h.audits.map((x) => x.kind)).toEqual([
    'epic_cross_project_reply_fallback',
    'epic_cross_project_reply_fallback',
  ]);
});

test('a removed (archived) earlier fallback Epic is not reused', async () => {
  const { a, input } = await setup();
  const h = makeHarness();
  const first = await openReplyFallbackSession(input(), h.deps);
  const idx = readIndex(a);
  delete idx.sessions[first.epicId];
  writeIndex(a, idx);
  const second = await openReplyFallbackSession(input(), h.deps);
  expect(second.epicId).not.toBe(first.epicId);
  expect(h.calls).toHaveLength(2);
});

test('a different replier Epic on the same asking Epic gets its own fallback Epic', async () => {
  const { input } = await setup();
  const h = makeHarness();
  const first = await openReplyFallbackSession(input({ fromEpicId: 'psess-y' }), h.deps);
  const second = await openReplyFallbackSession(input({ fromEpicId: 'psess-z' }), h.deps);
  expect(second.ok).toBe(true);
  expect(second.reused).toBeUndefined();
  expect(second.epicId).not.toBe(first.epicId);
  expect(h.calls).toHaveLength(2);
});

test('a different asking Epic or a non-feedback session is not reused', async () => {
  const { a, b, input } = await setup();
  const h = makeHarness();
  // A hand-made session with the right replyOf but a different producer.
  writeIndex(a, {
    sessions: {
      'psess-other': {
        id: 'psess-other', cwd: a, status: 'proposed',
        source: { producer: 'something-else', fromCwd: b, fromEpicId: 'psess-y', replyOf: { cwd: a, epicId: 'psess-x' } },
      },
      'psess-nosource': { id: 'psess-nosource', cwd: a, status: 'proposed' },
    },
    events: {},
  });
  const first = await openReplyFallbackSession(input(), h.deps);
  expect(first.reused).toBeUndefined();
  const second = await openReplyFallbackSession(input({ toEpicId: 'psess-x2' }), h.deps);
  expect(second.reused).toBeUndefined();
  expect(h.calls).toHaveLength(2);
});
