'use strict';

// A pending row held >30 min by a failed/cancelled dependency gets ONE
// Needs-you item per (cwd, blocking slug), posted once per episode and
// withdrawn when the hold clears. Self, 2026-11-22: 16 rows sat behind a
// cancelled dep and nothing told the owner why.
//
// Run: timeout 300 npx vitest run src/main/scheduler/__tests__/stall-dep-hold-needs-you.test.cjs

import { describe, it, expect, beforeEach } from 'vitest';
const budget = require('../budget.cjs');
const { applyDepHoldNotices, _resetDepHoldNoticesForTests } = require('../../scheduler.cjs');

const CWD = '/proj/self';
const OTHER = '/proj/other';
const NOW = Date.parse('2026-11-22T12:00:00Z');
const MIN = 60_000;
const SAT = () => new Map([[CWD, new Set()], [OTHER, new Set()]]);
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

const cancelledDep = (slug, cwd = CWD) => ({ slug, cwd, status: 'failed', cancelledAt: at(3 * 60 * MIN) });
const failedDep = (slug, cwd = CWD) => ({ slug, cwd, status: 'failed', error: 'exit 1' });
const pending = (slug, dep, ageMs, cwd = CWD) => ({
  slug, cwd, status: 'pending', createdAt: at(ageMs), dependsOn: [dep],
});

function classify(jobs) {
  return budget.classifyPendingHolds(jobs, { satisfiedSlugsByCwd: SAT(), now: NOW, thresholdMs: MIN });
}

/** In-memory stand-in for needsYouStore with the same post/withdraw/list semantics. */
function fakeStore() {
  const items = new Map();
  const calls = { post: [], withdraw: [] };
  return {
    items,
    calls,
    async listNeedsYou({ app, status } = {}) {
      return [...items.values()].filter((it) => (!app || it.app === app) && (!status || it.status === status));
    },
    async postNeedsYou(input) {
      calls.post.push(input);
      const key = `${input.app}|${input.id}`;
      const existing = items.get(key);
      if (existing) {
        if (existing.status !== 'open') return { item: existing, created: false, changed: false };
        const changed = existing.title !== input.title || existing.why !== input.why;
        Object.assign(existing, input);
        return { item: existing, created: false, changed };
      }
      const item = { ...input, status: 'open' };
      items.set(key, item);
      return { item, created: true, changed: true };
    },
    async withdrawNeedsYou({ app, id }) {
      calls.withdraw.push({ app, id });
      const item = items.get(`${app}|${id}`);
      if (!item || item.status !== 'open') return null;
      item.status = 'withdrawn';
      return item;
    },
  };
}

function harness() {
  const store = fakeStore();
  const audits = [];
  let changes = 0;
  const deps = { store, audit: (type, payload) => audits.push({ type, payload }), onChanged: () => { changes += 1; } };
  return { store, audits, deps, changes: () => changes };
}

describe('selectDepHoldNotices (pure)', () => {
  it('groups held rows by (cwd, root blocker) and posts only past 30 minutes', () => {
    const jobs = [
      cancelledDep('1056-contract'),
      pending('1060-a', '1056-contract', 45 * MIN),
      pending('1061-b', '1060-a', 45 * MIN),
      failedDep('2000-x', OTHER),
      pending('2001-y', '2000-x', 10 * MIN, OTHER),
    ];
    const { post, withdraw } = budget.selectDepHoldNotices(classify(jobs), new Set());
    expect(withdraw).toEqual([]);
    expect(post).toEqual([{
      id: budget.depHoldNoticeId(CWD, '1056-contract'),
      cwd: CWD,
      blockerSlug: '1056-contract',
      blockerStatus: 'cancelled',
      heldSlugs: ['1060-a', '1061-b'],
    }]);
  });

  it('never posts for a pending/running root or an unresolved dep', () => {
    const jobs = [
      { slug: '1-root', cwd: CWD, status: 'running' },
      pending('2-dep', '1-root', 60 * MIN),
      pending('3-ghost', 'never-existed', 60 * MIN),
    ];
    expect(budget.selectDepHoldNotices(classify(jobs), []).post).toEqual([]);
  });

  it('the notice text names the held slugs, blocker, status and the fix', () => {
    const { title, why } = budget.formatDepHoldNotice({
      cwd: CWD, blockerSlug: '1056-contract', blockerStatus: 'cancelled', heldSlugs: ['1060-a', '1061-b'],
    });
    expect(title).toBe('Scheduler: 2 PRDs in self held by cancelled 1056-contract');
    expect(why).toContain('1060-a, 1061-b');
    expect(why).toContain('1056-contract, which is cancelled');
    expect(why).toMatch(/Reset 1056-contract/);
    expect(why).toMatch(/archive\/dismiss/);
  });

  it('ids satisfy the Needs-you id pattern even for odd cwds', () => {
    const id = budget.depHoldNoticeId('/home/me/My Project (x)', '12-a b');
    expect(id).toMatch(/^[A-Za-z0-9._:/@-]{1,200}$/);
    expect(id.startsWith(budget.DEP_HOLD_NOTICE_ID_PREFIX)).toBe(true);
  });
});

describe('applyDepHoldNotices (scheduler.cjs side effect)', () => {
  beforeEach(() => _resetDepHoldNoticesForTests());

  const heldJobs = () => [
    cancelledDep('1056-contract'),
    pending('1060-a', '1056-contract', 45 * MIN),
    pending('1061-b', '1060-a', 45 * MIN),
  ];

  it('posts once per episode — repeat heartbeats do not re-post', async () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) await applyDepHoldNotices(classify(heldJobs()), h.deps);
    expect(h.store.calls.post).toHaveLength(1);
    const [posted] = h.store.calls.post;
    expect(posted).toMatchObject({ app: 'session-manager', id: budget.depHoldNoticeId(CWD, '1056-contract') });
    expect(posted.title).toContain('1056-contract');
    expect(posted.why).toContain('1060-a, 1061-b');
    expect(h.audits.filter((a) => a.type === 'stall_dep_hold_posted')).toHaveLength(1);
    expect(h.audits[0].payload).toMatchObject({
      cwd: CWD, blockerSlug: '1056-contract', blockerStatus: 'cancelled', heldSlugs: ['1060-a', '1061-b'],
    });
    expect(h.changes()).toBe(1);
  });

  it('withdraws when no row is held by that blocker any more', async () => {
    const h = harness();
    await applyDepHoldNotices(classify(heldJobs()), h.deps);
    // Owner resets the blocker: it is pending again, so the chain root is no longer dead.
    const cleared = heldJobs();
    cleared[0] = { slug: '1056-contract', cwd: CWD, status: 'pending', createdAt: at(0) };
    await applyDepHoldNotices(classify(cleared), h.deps);
    await applyDepHoldNotices(classify(cleared), h.deps);
    expect(h.store.calls.withdraw).toEqual([{ app: 'session-manager', id: budget.depHoldNoticeId(CWD, '1056-contract') }]);
    expect(h.audits.map((a) => a.type)).toEqual(['stall_dep_hold_posted', 'stall_dep_hold_withdrawn']);
    expect([...h.store.items.values()][0].status).toBe('withdrawn');
    expect(h.changes()).toBe(2);

    // A new hold after the clear is a new episode → posted again.
    await applyDepHoldNotices(classify(heldJobs()), h.deps);
    expect(h.store.calls.post).toHaveLength(2);
  });

  it('does not post while the hold is under 30 minutes', async () => {
    const h = harness();
    const young = [cancelledDep('1056-contract'), pending('1060-a', '1056-contract', 29 * MIN)];
    await applyDepHoldNotices(classify(young), h.deps);
    expect(h.store.calls.post).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.changes()).toBe(0);
  });

  it('a failed blocker posts too, one item per (cwd, blocker)', async () => {
    const h = harness();
    const jobs = [
      failedDep('5-root'), pending('6-a', '5-root', 40 * MIN),
      failedDep('5-root', OTHER), pending('6-a', '5-root', 40 * MIN, OTHER),
    ];
    await applyDepHoldNotices(classify(jobs), h.deps);
    expect(h.store.calls.post.map((p) => p.id).sort()).toEqual(
      [budget.depHoldNoticeId(CWD, '5-root'), budget.depHoldNoticeId(OTHER, '5-root')].sort(),
    );
    expect(h.store.calls.post[0].title).toContain('failed 5-root');
  });

  it('after a restart, an open notice left in the store is withdrawn once its hold is gone', async () => {
    const h = harness();
    await applyDepHoldNotices(classify(heldJobs()), h.deps);
    _resetDepHoldNoticesForTests(); // simulated app restart: in-memory episode state lost
    await applyDepHoldNotices([], h.deps);
    expect(h.store.calls.withdraw).toHaveLength(1);
    expect(h.audits.at(-1).type).toBe('stall_dep_hold_withdrawn');
  });
});
