/**
 * pendingReplies.test.cjs — the machine-wide ledger of 'it's live' replies owed
 * once Session Manager runs a version above a given one
 * (lib/feedback-remote/pendingReplies.cjs).
 *
 * Run: timeout 180 npx vitest run src/main/lib/feedback-remote/__tests__/pendingReplies.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../pendingReplies.cjs');

let tmp;
let prevHome;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pending-replies-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = tmp;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function entry(over = {}) {
  return {
    replierCwd: '/p/b',
    yId: 'epic-y',
    goalText: 'Ship the fix',
    thread: { cwd: '/p/a', epicId: 'epic-x', claudeSessionId: 'sess-x', legacy: false, mode: 'chat' },
    targetCwd: '/p/a',
    outcome: 'done',
    message: 'It is live.',
    referencePaths: ['src/a.cjs'],
    appVersionAbove: '0.141.0',
    ...over,
  };
}

test('ledger file is pending-replies.json in SM_SCHEDULER_HOME', () => {
  expect(ledger.ledgerPath()).toBe(path.join(tmp, 'pending-replies.json'));
});

test('add stores every field and persists to disk', () => {
  const e = ledger.addPendingReply(entry());
  expect(typeof e.id).toBe('string');
  expect(e.id.length).toBeGreaterThan(10);
  expect(typeof e.createdAt).toBe('string');
  expect(e).toMatchObject({
    replierCwd: '/p/b', yId: 'epic-y', goalText: 'Ship the fix',
    thread: { cwd: '/p/a', epicId: 'epic-x', claudeSessionId: 'sess-x', legacy: false, mode: 'chat' },
    targetCwd: '/p/a', outcome: 'done', message: 'It is live.', referencePaths: ['src/a.cjs'],
    appVersionAbove: '0.141.0', deliveredAt: null, deliveredVersion: null, lastError: null,
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'pending-replies.json'), 'utf8'));
  expect(onDisk.entries).toHaveLength(1);
  expect(onDisk.entries[0].id).toBe(e.id);
});

test('add refuses an appVersionAbove that is not x.y.z', () => {
  for (const bad of ['0.141', 'v0.141.0', '0.141.0-beta', '', undefined, 141]) {
    expect(() => ledger.addPendingReply(entry({ appVersionAbove: bad }))).toThrow(/appVersionAbove/);
  }
  expect(fs.existsSync(path.join(tmp, 'pending-replies.json'))).toBe(false);
});

test('due = undelivered and appVersionAbove strictly lower than appVersion', () => {
  const a = ledger.addPendingReply(entry({ appVersionAbove: '0.141.0' }));
  const b = ledger.addPendingReply(entry({ appVersionAbove: '0.142.0' }));
  expect(ledger.listDueReplies('0.141.0')).toEqual([]);
  expect(ledger.listDueReplies('0.141.1').map((e) => e.id)).toEqual([a.id]);
  expect(ledger.listDueReplies('0.142.0').map((e) => e.id)).toEqual([a.id]);
  expect(ledger.listDueReplies('0.143.0').map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
});

test('an equal version is not due', () => {
  ledger.addPendingReply(entry({ appVersionAbove: '1.2.3' }));
  expect(ledger.listDueReplies('1.2.3')).toEqual([]);
  expect(ledger.listDueReplies('1.2.2')).toEqual([]);
});

test('markReplyDelivered stamps deliveredAt + version and leaves the due list', () => {
  const a = ledger.addPendingReply(entry());
  const updated = ledger.markReplyDelivered(a.id, { version: '0.142.0', result: { ok: true } });
  expect(updated.deliveredVersion).toBe('0.142.0');
  expect(typeof updated.deliveredAt).toBe('string');
  expect(updated.lastError).toBeNull();
  expect(ledger.listDueReplies('0.150.0')).toEqual([]);
});

test('markReplyDelivered with a failed result records lastError and stays due', () => {
  const a = ledger.addPendingReply(entry());
  const updated = ledger.markReplyDelivered(a.id, { version: '0.142.0', result: { ok: false, error: 'target closed' } });
  expect(updated.deliveredAt).toBeNull();
  expect(updated.lastError).toBe('target closed');
  expect(ledger.listDueReplies('0.142.0').map((e) => e.id)).toEqual([a.id]);
});

test('markReplyDelivered on an unknown id returns null', () => {
  expect(ledger.markReplyDelivered('nope', { version: '1.0.0', result: { ok: true } })).toBeNull();
});

test('countPendingForThread counts undelivered entries for (replierCwd, yId)', () => {
  const a = ledger.addPendingReply(entry());
  ledger.addPendingReply(entry());
  ledger.addPendingReply(entry({ yId: 'other' }));
  ledger.addPendingReply(entry({ replierCwd: '/p/c' }));
  expect(ledger.countPendingForThread('/p/b', 'epic-y')).toBe(2);
  ledger.markReplyDelivered(a.id, { version: '0.142.0', result: { ok: true } });
  expect(ledger.countPendingForThread('/p/b', 'epic-y')).toBe(1);
  expect(ledger.countPendingForThread('/p/none', 'epic-y')).toBe(0);
});

test('missing or corrupt ledger reads as empty without throwing', () => {
  expect(ledger.listDueReplies('9.9.9')).toEqual([]);
  expect(ledger.countPendingForThread('/p/b', 'epic-y')).toBe(0);
  fs.writeFileSync(path.join(tmp, 'pending-replies.json'), '{not json');
  expect(() => ledger.listDueReplies('9.9.9')).not.toThrow();
  expect(ledger.listDueReplies('9.9.9')).toEqual([]);
  expect(ledger.countPendingForThread('/p/b', 'epic-y')).toBe(0);
  fs.writeFileSync(path.join(tmp, 'pending-replies.json'), JSON.stringify({ entries: 'nope' }));
  expect(ledger.listDueReplies('9.9.9')).toEqual([]);
  const a = ledger.addPendingReply(entry());
  expect(ledger.listDueReplies('9.9.9').map((e) => e.id)).toEqual([a.id]);
});

test('ySource and sentAtScheduling are stored; a non-plain ySource or bad count is dropped to null', () => {
  const src = { producer: 'cross-project-feedback', externalRef: 'ext-9', proposal: { motivation: 'm' }, replyTo: { cwd: '/p/a', mode: 'event' } };
  const kept = ledger.addPendingReply(entry({ ySource: src, sentAtScheduling: 2 }));
  expect(kept.ySource).toEqual(src);
  expect(kept.ySource).not.toBe(src);
  expect(kept.sentAtScheduling).toBe(2);
  for (const bad of [null, 'x', 5, [], new Date()]) {
    expect(ledger.buildEntry(entry({ ySource: bad })).ySource).toBeNull();
  }
  for (const bad of [0, -1, 1.5, '2', undefined]) {
    expect(ledger.buildEntry(entry({ sentAtScheduling: bad })).sentAtScheduling).toBeNull();
  }
  const onDisk = JSON.parse(fs.readFileSync(ledger.ledgerPath(), 'utf8')).entries[0];
  expect(onDisk).toMatchObject({ ySource: src, sentAtScheduling: 2 });
});

test('a failed attempt increments attempts; the 24th failure stamps gaveUpAt and the entry is never due again', () => {
  const e = ledger.addPendingReply(entry({ hash: 'h1' }));
  expect(e).toMatchObject({ attempts: 0, gaveUpAt: null, hash: 'h1' });
  let last;
  for (let i = 1; i < ledger.MAX_DELIVERY_ATTEMPTS; i++) {
    last = ledger.markReplyDelivered(e.id, { version: '0.142.0', result: { ok: false, error: `fail ${i}` } });
    expect(last).toMatchObject({ attempts: i, gaveUpAt: null, lastError: `fail ${i}` });
    expect(ledger.listDueReplies('0.142.0').map((x) => x.id)).toEqual([e.id]);
  }
  last = ledger.markReplyDelivered(e.id, { version: '0.142.0', result: { ok: false, error: 'fail 24' } });
  expect(ledger.MAX_DELIVERY_ATTEMPTS).toBe(24);
  expect(last).toMatchObject({ attempts: 24, lastError: 'fail 24', deliveredAt: null });
  expect(last.gaveUpAt).toEqual(expect.any(String));
  expect(ledger.listDueReplies('0.142.0')).toEqual([]);
  expect(ledger.listDueReplies('9.0.0')).toEqual([]);
});

test('listPendingForThread returns undelivered, not-given-up entries of that thread only', () => {
  const a = ledger.addPendingReply(entry({ hash: 'ha' }));
  const b = ledger.addPendingReply(entry({ hash: 'hb' }));
  ledger.addPendingReply(entry({ yId: 'other', hash: 'ha' }));
  ledger.markReplyDelivered(b.id, { version: '0.142.0', result: { ok: true } });
  expect(ledger.listPendingForThread('/p/b', 'epic-y').map((x) => x.id)).toEqual([a.id]);
});

test('a given-up entry no longer counts toward the thread pending count (frees its slot)', () => {
  const a = ledger.addPendingReply(entry({ hash: 'ha' }));
  const b = ledger.addPendingReply(entry({ hash: 'hb' }));
  expect(ledger.countPendingForThread('/p/b', 'epic-y')).toBe(2);
  for (let i = 1; i <= ledger.MAX_DELIVERY_ATTEMPTS; i++) {
    ledger.markReplyDelivered(a.id, { version: '0.142.0', result: { ok: false, error: `fail ${i}` } });
  }
  expect(ledger.countPendingForThread('/p/b', 'epic-y')).toBe(1);
  expect(ledger.countPendingForThread('/p/b', 'epic-y')).toBe(ledger.listPendingForThread('/p/b', 'epic-y').length);
  expect(ledger.listPendingForThread('/p/b', 'epic-y').map((x) => x.id)).toEqual([b.id]);
});

test('add keeps release commits lowercased and de-duplicated; invalid hashes dropped', () => {
  const e = ledger.addPendingReply(entry({ commits: ['ABC1234', 'abc1234', 'not-hex', 42, 'DEF5678abc'] }));
  expect(e.commits).toEqual(['abc1234', 'def5678abc']);
  expect(ledger.listDueReplies('0.142.0')[0].commits).toEqual(['abc1234', 'def5678abc']);
});

test('add omits the commits key when none are given or none are valid', () => {
  expect('commits' in ledger.addPendingReply(entry())).toBe(false);
  expect('commits' in ledger.addPendingReply(entry({ commits: [] }))).toBe(false);
  expect('commits' in ledger.addPendingReply(entry({ commits: ['zz'] }))).toBe(false);
});

test('add keeps at most MAX_COMMITS (20) valid hashes: a 25-commit entry stores its first 20', () => {
  const { MAX_COMMITS } = require('../replyClaims.cjs');
  const hashes = Array.from({ length: 25 }, (_, i) => `abc${String(i).padStart(4, '0')}`);
  const e = ledger.addPendingReply(entry({ commits: ['not-hex', ...hashes] }));
  expect(MAX_COMMITS).toBe(20);
  expect(e.commits).toEqual(hashes.slice(0, 20));
  expect(ledger.listDueReplies('0.142.0')[0].commits).toEqual(hashes.slice(0, 20));
});

test('pendingReplies keeps exactly the commits replyClaims.isCommitHash accepts', () => {
  const { isCommitHash } = require('../replyClaims.cjs');
  const candidates = ['abc1234', 'ABC1234', 'abc12', 'zzzzzzz', 'a'.repeat(40), 'a'.repeat(41), '', 42, null, ' abc1234', 'DEF5678'];
  const expected = [...new Set(candidates.filter(isCommitHash).map((c) => String(c).toLowerCase()))];
  expect(expected.length).toBeGreaterThan(1);
  expect(expected.length).toBeLessThan(candidates.length);
  const kept = [];
  for (const c of candidates) {
    const e = ledger.addPendingReply(entry({ commits: [c] }));
    if (isCommitHash(c)) {
      expect(e.commits).toEqual([String(c).toLowerCase()]);
      kept.push(...e.commits);
    } else {
      // rejected-only entry stores no commits at all
      expect('commits' in e).toBe(false);
    }
  }
  expect([...new Set(kept)]).toEqual(expected);
});
