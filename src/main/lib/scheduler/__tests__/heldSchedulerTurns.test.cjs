'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/heldSchedulerTurns.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MOD = path.resolve(__dirname, '../heldSchedulerTurns.cjs');
const PATHS = path.resolve(__dirname, '../schedulerPaths.cjs');

function freshModule() {
  vi.resetModules();
  delete require.cache[MOD];
  return require(MOD);
}

const HOLD = { reason: 'usage', detail: '5h window at 92% ≥ pause above 90%', window: 'five_hour', percent: 92, threshold: 90, resetsAt: null };

let home;
let prevHome;
beforeEach(() => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'held-turns-'));
  process.env.SM_SCHEDULER_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function storeFile() { return require(PATHS).heldSchedulerTurnsPath(); }

describe('heldSchedulerTurnsPath', () => {
  it('lives under SM_SCHEDULER_HOME', () => {
    assert.equal(storeFile(), path.join(home, 'held-scheduler-turns.json'));
  });
});

describe('hold provider', () => {
  it('returns null with no provider, the hold with one, null when it throws', () => {
    const m = freshModule();
    assert.equal(m.currentHold(), null);
    m.setHoldProvider(() => HOLD);
    assert.deepEqual(m.currentHold(), HOLD);
    m.setHoldProvider(() => { throw new Error('boom'); });
    assert.equal(m.currentHold(), null);
    m.setHoldProvider(() => undefined);
    assert.equal(m.currentHold(), null);
  });
});

describe('defer', () => {
  it('stores an entry atomically and dedupes tabId+kind+prompt', () => {
    const m = freshModule();
    const a = m.defer({ tabId: 't1', prompt: 'digest A', kind: 'settle-digest', sessionId: 's1', cwd: '/p', hold: HOLD });
    const b = m.defer({ tabId: 't1', prompt: 'digest A', kind: 'settle-digest', hold: HOLD });
    assert.equal(b.id, a.id);
    m.defer({ tabId: 't1', prompt: 'digest A', kind: 'job-notice', hold: HOLD });
    m.defer({ tabId: 't2', prompt: 'digest A', kind: 'settle-digest', hold: HOLD });
    const file = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    assert.equal(file.version, 1);
    assert.equal(file.entries.length, 3);
    const first = file.entries[0];
    assert.equal(first.tabId, 't1');
    assert.equal(first.sessionId, 's1');
    assert.equal(first.cwd, '/p');
    assert.equal(first.holdReason, 'usage');
    assert.equal(first.holdDetail, HOLD.detail);
    assert.ok(!Number.isNaN(Date.parse(first.heldAt)));
    assert.deepEqual(m.summary(), { count: 3, tabs: ['t1', 't2'] });
  });
});

describe('summary', () => {
  it('lists unique tab ids oldest-held first, at most 20', () => {
    const m = freshModule();
    const entries = [
      { id: 'e1', tabId: 'late', prompt: 'p', kind: 'job-notice', heldAt: '2026-11-24T12:00:00Z' },
      { id: 'e2', tabId: 'early', prompt: 'p', kind: 'job-notice', heldAt: '2026-11-24T10:00:00Z' },
      { id: 'e3', tabId: 'late', prompt: 'q', kind: 'job-notice', heldAt: '2026-11-24T09:00:00Z' },
    ];
    for (let i = 0; i < 25; i += 1) {
      entries.push({ id: `x${i}`, tabId: `tab${i}`, prompt: 'p', kind: 'job-notice', heldAt: `2026-11-25T${String(i).padStart(2, '0')}:00:00Z` });
    }
    fs.writeFileSync(storeFile(), JSON.stringify({ version: 1, entries }));
    const sum = m.summary();
    assert.equal(sum.count, 28);
    assert.ok(Array.isArray(sum.tabs));
    assert.equal(sum.tabs.length, 20);
    assert.deepEqual(sum.tabs.slice(0, 3), ['late', 'early', 'tab0']);
    assert.equal(sum.tabs[19], 'tab17');
  });
});

describe('restart', () => {
  it('a fresh module instance reads back held entries', () => {
    const m1 = freshModule();
    m1.defer({ tabId: 't1', prompt: 'p1', kind: 'job-notice', hold: HOLD });
    const m2 = freshModule();
    assert.notEqual(m1, m2);
    assert.deepEqual(m2.summary(), { count: 1, tabs: ['t1'] });
  });

  it('a corrupt or missing file reads as empty', async () => {
    const m = freshModule();
    assert.deepEqual(m.summary(), { count: 0, tabs: [] });
    fs.writeFileSync(storeFile(), '{not json');
    assert.deepEqual(m.summary(), { count: 0, tabs: [] });
    fs.writeFileSync(storeFile(), JSON.stringify({ version: 1, entries: 'nope' }));
    assert.deepEqual(m.summary(), { count: 0, tabs: [] });
    assert.deepEqual(await m.drain({ send: async () => ({ disposition: 'queued' }) }), []);
  });
});

describe('buildCoalescedPrompt / drain', () => {
  it('sends one coalesced prompt per tab, oldest first, and removes on accept', async () => {
    const m = freshModule();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
      m.defer({ tabId: 't1', prompt: 'first', kind: 'job-notice', sessionId: 's1', cwd: '/p', hold: HOLD });
      vi.setSystemTime(new Date('2026-11-24T10:01:00Z'));
      m.defer({ tabId: 't1', prompt: 'second', kind: 'settle-digest', hold: HOLD });
      vi.setSystemTime(new Date('2026-11-24T10:02:00Z'));
      m.defer({ tabId: 't1', prompt: 'third', kind: 'auto-start-follow-up', hold: HOLD });
    } finally {
      vi.useRealTimers();
    }
    // Shuffle the on-disk order: delivery must follow heldAt, not file order.
    const file = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    file.entries.reverse();
    fs.writeFileSync(storeFile(), JSON.stringify(file));

    const calls = [];
    const res = await m.drain({ send: async (tabId, prompt, extra) => { calls.push({ tabId, prompt, extra }); return { disposition: 'started' }; } });
    assert.equal(calls.length, 1);
    const { prompt, extra } = calls[0];
    assert.ok(prompt.startsWith('The usage hold kept 3 scheduler message(s) for this session while automatic work was paused. They are delivered now, oldest first.'));
    const i1 = prompt.indexOf('--- 1 of 3 ---\nfirst');
    const i2 = prompt.indexOf('--- 2 of 3 ---\nsecond');
    const i3 = prompt.indexOf('--- 3 of 3 ---\nthird');
    assert.ok(i1 > 0 && i2 > i1 && i3 > i2, prompt);
    assert.deepEqual(extra, { origin: 'scheduler', heldBatch: true, sessionId: 's1', cwd: '/p' });
    assert.deepEqual(res, [{ tabId: 't1', delivered: 3, dropped: 0 }]);
    assert.deepEqual(m.summary(), { count: 0, tabs: [] });
  });

  it('one entry still gets the header', () => {
    const m = freshModule();
    const out = m.buildCoalescedPrompt([{ prompt: 'only', heldAt: '2026-11-24T10:00:00Z' }]);
    assert.ok(out.startsWith('The usage hold kept 1 scheduler message(s)'));
    assert.ok(out.includes('--- 1 of 1 ---\nonly'));
  });

  for (const disposition of ['refused', 'unconfirmed', 'held']) {
    it(`keeps entries when send resolves '${disposition}'`, async () => {
      const m = freshModule();
      m.defer({ tabId: 't1', prompt: 'p1', kind: 'job-notice', hold: HOLD });
      const res = await m.drain({ send: async () => ({ disposition }) });
      assert.deepEqual(res, [{ tabId: 't1', delivered: 0, dropped: 0 }]);
      assert.deepEqual(m.summary(), { count: 1, tabs: ['t1'] });
    });
  }

  it('hold returns mid-drain: the originals stay, no coalesced entry, then one un-nested delivery', async () => {
    const m = freshModule();
    m.defer({ tabId: 't1', prompt: 'a', kind: 'job-notice', hold: HOLD });
    m.defer({ tabId: 't1', prompt: 'b', kind: 'settle-digest', hold: HOLD });
    m.defer({ tabId: 't1', prompt: 'c', kind: 'auto-start-follow-up', hold: HOLD });
    const before = JSON.parse(fs.readFileSync(storeFile(), 'utf8')).entries.map((e) => e.id).sort();
    const res = await m.drain({ send: async () => ({ disposition: 'held', reason: 'usage' }) });
    assert.deepEqual(res, [{ tabId: 't1', delivered: 0, dropped: 0 }]);
    const left = JSON.parse(fs.readFileSync(storeFile(), 'utf8')).entries;
    assert.deepEqual(left.map((e) => e.id).sort(), before);
    assert.ok(left.every((e) => !e.prompt.includes('The usage hold kept')));
    const calls = [];
    await m.drain({ send: async (tabId, prompt) => { calls.push(prompt); return { disposition: 'started' }; } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].split('The usage hold kept').length - 1, 1);
    assert.ok(calls[0].includes('--- 3 of 3 ---\nc'));
    assert.deepEqual(m.summary(), { count: 0, tabs: [] });
  });

  it('keeps entries when send throws', async () => {
    const m = freshModule();
    m.defer({ tabId: 't1', prompt: 'p1', kind: 'job-notice', hold: HOLD });
    await m.drain({ send: async () => { throw new Error('x'); } });
    assert.deepEqual(m.summary(), { count: 1, tabs: ['t1'] });
  });

  it('isStillNeeded=false drops without sending', async () => {
    const m = freshModule();
    m.defer({ tabId: 't1', prompt: 'stale', kind: 'job-notice', hold: HOLD });
    m.defer({ tabId: 't1', prompt: 'live', kind: 'job-notice', hold: HOLD });
    m.defer({ tabId: 't2', prompt: 'stale2', kind: 'job-notice', hold: HOLD });
    const calls = [];
    const res = await m.drain({
      send: async (tabId, prompt) => { calls.push({ tabId, prompt }); return { disposition: 'queued' }; },
      isStillNeeded: (e) => !e.prompt.startsWith('stale'),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tabId, 't1');
    assert.ok(calls[0].prompt.includes('live') && !calls[0].prompt.includes('stale'));
    const byTab = Object.fromEntries(res.map((r) => [r.tabId, r]));
    assert.deepEqual(byTab.t1, { tabId: 't1', delivered: 1, dropped: 1 });
    assert.deepEqual(byTab.t2, { tabId: 't2', delivered: 0, dropped: 1 });
    assert.deepEqual(m.summary(), { count: 0, tabs: [] });
  });

  it('keeps entries deferred during a drain, and is single-flight', async () => {
    const m = freshModule();
    m.defer({ tabId: 't1', prompt: 'p1', kind: 'job-notice', hold: HOLD });
    let release;
    const gate = new Promise((r) => { release = r; });
    let sends = 0;
    const send = async () => { sends += 1; await gate; return { disposition: 'started' }; };
    const d1 = m.drain({ send });
    const d2 = m.drain({ send });
    await new Promise((r) => setImmediate(r));
    m.defer({ tabId: 't1', prompt: 'p2-late', kind: 'job-notice', hold: HOLD });
    release();
    const [r1, r2] = await Promise.all([d1, d2]);
    assert.equal(sends, 1);
    assert.deepEqual(r1, r2);
    const left = JSON.parse(fs.readFileSync(storeFile(), 'utf8')).entries;
    assert.deepEqual(left.map((e) => e.prompt), ['p2-late']);
  });

  it('timeout then late ack: entries stamped, skipped, confirmLateDelivery removes exactly them', async () => {
    const m = freshModule();
    m.defer({ tabId: 't1', prompt: 'a', kind: 'job-notice', hold: HOLD });
    m.defer({ tabId: 't2', prompt: 'b', kind: 'job-notice', hold: HOLD });
    let n = 0;
    const calls = [];
    const send = async (tabId) => {
      calls.push(tabId);
      n += 1;
      return tabId === 't1' ? { disposition: 'unconfirmed', reason: 'timeout', requestId: `rq-${n}` } : { disposition: 'unconfirmed', reason: 'no-window' };
    };
    await m.drain({ send });
    const file = JSON.parse(fs.readFileSync(storeFile(), 'utf8')).entries;
    const a = file.find((e) => e.prompt === 'a');
    const b = file.find((e) => e.prompt === 'b');
    assert.equal(a.lastAttempt.requestId, 'rq-1');
    assert.ok(!Number.isNaN(Date.parse(a.lastAttempt.at)));
    assert.equal(b.lastAttempt, undefined);
    assert.equal(m.confirmLateDelivery('rq-unknown'), 0);
    assert.equal(m.confirmLateDelivery('rq-1'), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(storeFile(), 'utf8')).entries.map((e) => e.prompt), ['b']);
    calls.length = 0;
    await m.drain({ send: async (tabId) => { calls.push(tabId); return { disposition: 'queued' }; } });
    assert.deepEqual(calls, ['t2']);
  });

  it('timeout and no ack: skipped during the grace, resent once after it', async () => {
    const m = freshModule();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
      m.defer({ tabId: 't1', prompt: 'a', kind: 'job-notice', hold: HOLD });
      const calls = [];
      const lost = async (tabId) => { calls.push(tabId); return { disposition: 'unconfirmed', reason: 'timeout', requestId: 'rq-x' }; };
      await m.drain({ send: lost });
      assert.equal(calls.length, 1);
      vi.advanceTimersByTime(m.LAST_ATTEMPT_GRACE_MS - 1000);
      assert.deepEqual(await m.drain({ send: lost }), []);
      assert.equal(calls.length, 1);
      vi.advanceTimersByTime(2000);
      const ok = async (tabId) => { calls.push(tabId); return { disposition: 'queued' }; };
      assert.deepEqual(await m.drain({ send: ok }), [{ tabId: 't1', delivered: 1, dropped: 0 }]);
      assert.equal(calls.length, 2);
      assert.deepEqual(await m.drain({ send: ok }), []);
      assert.equal(calls.length, 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
