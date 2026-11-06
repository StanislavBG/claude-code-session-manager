'use strict';
import { describe, it, expect } from 'vitest';
const { macroJobStatuses, HISTORY_TAIL_BYTES } = require('../macroJobStatus.cjs');

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
