'use strict';
import { describe, it, expect } from 'vitest';
const { macroJobStatuses, HISTORY_TAIL_BYTES, REASON_MAX } = require('../macroJobStatus.cjs');

const builtins = [{ id: 'a', job: {} }, { id: 'b', job: {} }, { id: 'c' }];
const CWD = '/p';
const hist = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n');

describe('macroJobStatuses', () => {
  it('maps statuses to states, exact shape, omits macros without rows or job', async () => {
    const cases = { pending: 'queued', held: 'queued', blocked: 'queued', deferred: 'queued', running: 'running', investigating: 'running', completed: 'done', failed: 'failed', needs_review: 'failed', skipped: 'failed', cancelled: 'failed' };
    for (const [status, state] of Object.entries(cases)) {
      const res = await macroJobStatuses({ cwd: CWD }, {
        loadJobs: async () => [{ cwd: CWD, macroId: 'a', slug: 's', status, epicId: 'e', startedAt: 't1', finishedAt: null }],
        readHistoryTail: async () => '',
        builtins,
      });
      expect(res).toHaveLength(1);
      expect(Object.keys(res[0]).sort()).toEqual(['epicId', 'finishedAt', 'macroId', 'reason', 'slug', 'startedAt', 'state', 'status']);
      expect(res[0].state).toBe(state);
      expect(res[0].macroId).toBe('a');
      if (state !== 'failed') expect(res[0].reason).toBeNull();
    }
    const nullStatus = await macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [{ cwd: CWD, macroId: 'a', status: null }], readHistoryTail: async () => '', builtins });
    expect(nullStatus[0].state).toBe('queued');
  });

  it('builds failure reasons', async () => {
    const run = (row) => macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [{ cwd: CWD, macroId: 'a', status: 'failed', ...row }], readHistoryTail: async () => '', builtins }).then((r) => r[0].reason);
    expect(await run({ verifierVerdict: 'budget_exceeded', budgetMinutes: 30 })).toBe('Timed out at the 30-minute job budget');
    expect(await run({ verifierVerdict: 'budget_exceeded' })).toBe('Timed out at the job budget');
    expect(await run({ error: 'boom' })).toBe('boom');
    expect(await run({ finalizeReason: 'fin' })).toBe('fin');
    expect(await run({})).toBe('Ended as failed');
  });

  it('reads history only without a live row, bounded, tolerating torn data', async () => {
    let calls = 0;
    const readHistoryTail = async () => { calls++; return hist({ cwd: CWD, macroId: 'b', slug: 'old', status: 'completed', finishedAt: '2026-01-01T00:00:00Z' }, { cwd: CWD, macroId: 'b', slug: 'new', status: 'failed', finishedAt: '2026-02-01T00:00:00Z' }) + '\n{"torn'; };
    const res = await macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [{ cwd: CWD, macroId: 'a', status: 'running' }], readHistoryTail, builtins });
    expect(calls).toBe(1);
    expect(res.map((r) => r.macroId)).toEqual(['a', 'b']);
    expect(res[1].slug).toBe('new');

    calls = 0;
    await macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [{ cwd: CWD, macroId: 'a', status: 'running' }, { cwd: CWD, macroId: 'b', status: 'pending' }], readHistoryTail, builtins });
    expect(calls).toBe(0);

    for (const bad of [async () => '', async () => '{"torn', async () => { throw new Error('x'); }]) {
      expect(await macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [], readHistoryTail: bad, builtins })).toEqual([]);
    }
    expect(HISTORY_TAIL_BYTES).toBe(524288);
  });
});

describe('macroJobStatuses — project Video tools', () => {
  const tool = (over = {}) => ({ id: 't1', surface: 'project-video', projects: [CWD], job: { review: true }, ...over });
  const review = (entryId, slug, stage, status) => ({ entryId, dispatch: { slug, stage }, status });
  const run = (rows, { macros = [tool()], reviews = [], hist: h = '' } = {}) => macroJobStatuses({ cwd: CWD }, {
    loadJobs: async () => rows, readHistoryTail: async () => h, builtins, macros, listReviews: async () => reviews,
  });

  it('reports a tool like a built-in with entryId matched by slug; other tools are left out', async () => {
    const macros = [tool(), tool({ id: 't2', projects: ['/other'] }), tool({ id: 't3', surface: 'project-home' }), tool({ id: 't4', job: undefined })];
    const rows = ['t1', 't2', 't3', 't4'].map((id) => ({ cwd: CWD, macroId: id, slug: `s-${id}`, status: 'running', epicId: 'e' }));
    const res = await run(rows, { macros, reviews: [review('vid-x', 'other'), review('vid-1', 's-t1', 'review', 'building')] });
    expect(res).toEqual([{ macroId: 't1', epicId: 'e', slug: 's-t1', state: 'running', status: 'running', reason: null, startedAt: null, finishedAt: null, entryId: 'vid-1' }]);
    expect((await run([{ cwd: CWD, macroId: 't1', slug: 'nope', status: 'pending' }]))[0].entryId).toBeNull();
    // history fallback works for a tool too
    expect((await run([], { hist: hist({ cwd: CWD, macroId: 't1', slug: 'h', status: 'completed' }) }))[0]).toMatchObject({ slug: 'h', state: 'done' });
  });

  it("a failed or needs_review run carries a one-line reason of at most 200 chars", async () => {
    for (const status of ['failed', 'needs_review']) {
      const [r] = await run([{ cwd: CWD, macroId: 't1', slug: 's', status, error: `\n  first line ${'y'.repeat(300)}\nsecond line` }]);
      expect(r.state).toBe('failed');
      expect(r.reason.startsWith('first line')).toBe(true);
      expect(r.reason).not.toContain('second');
      expect(r.reason.length).toBe(REASON_MAX);
      expect(REASON_MAX).toBe(200);
    }
    const [b] = await macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [{ cwd: CWD, macroId: 'a', status: 'needs_review', error: 'one\ntwo' }], readHistoryTail: async () => '', builtins });
    expect(b.reason).toBe('one');
  });

  it("a completed review-stage run whose entry is 'waiting' reports awaiting_review", async () => {
    const row = { cwd: CWD, macroId: 't1', slug: 's', status: 'completed' };
    expect((await run([row], { reviews: [review('vid-1', 's', 'review', 'waiting')] }))[0]).toMatchObject({ status: 'awaiting_review', entryId: 'vid-1' });
    expect((await run([row], { reviews: [review('vid-1', 's', 'review', 'approved')] }))[0].status).toBe('completed');
    expect((await run([row], { reviews: [review('vid-1', 's', 'final', 'waiting')] }))[0].status).toBe('completed');
    expect((await run([{ ...row, status: 'running' }], { reviews: [review('vid-1', 's', 'review', 'waiting')] }))[0].status).toBe('running');
  });

  it('a throwing listReviews yields entryId null; built-ins never read reviews', async () => {
    const [r] = await macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [{ cwd: CWD, macroId: 't1', slug: 's', status: 'running' }], readHistoryTail: async () => '', builtins, macros: [tool()], listReviews: async () => { throw new Error('x'); } });
    expect(r.entryId).toBeNull();
    let called = 0;
    await macroJobStatuses({ cwd: CWD }, { loadJobs: async () => [{ cwd: CWD, macroId: 'a', status: 'running' }], readHistoryTail: async () => '', builtins, listReviews: async () => { called++; return []; } });
    expect(called).toBe(0);
  });
});
