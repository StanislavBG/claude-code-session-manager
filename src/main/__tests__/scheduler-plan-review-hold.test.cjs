'use strict';

// Run: timeout 300 npx vitest run src/main/__tests__/scheduler-plan-review-hold.test.cjs

import { describe, it, expect, vi } from 'vitest';
const sched = require('../scheduler.cjs');
const { pickNextBatch } = require('../lib/scheduler/schedulerBatch.cjs');
const { evaluateEpicSettle } = require('../lib/epic/epicSettle.cjs');

const EPIC = 'abcd1234';
const row = (slug, extra = {}) => ({ slug, status: 'pending', cwd: '/p', sourcePromptId: EPIC, dependsOn: [], ...extra });
const mk = () => [
  row('1-a'), row('2-b'), row('3-c'),
  row('90-validate', { agentType: 'validator', planReview: 'required', dependsOn: ['a', 'b', 'c'], createdAt: '2026-01-01T00:00:00Z' }),
];
const T0 = Date.parse('2026-01-01T00:10:00Z');

function deps(over = {}) {
  const reviews = over.reviews || {};
  return {
    now: T0,
    holdMs: 4 * 3600 * 1000,
    readReview: (cwd, e, slug) => reviews[slug] || null,
    createPrd: vi.fn(async (input) => ({ ok: true, slug: input.slug })),
    recordRelease: vi.fn(async ({ validateSlug }) => { reviews[validateSlug] = { release: { by: 'timeout' } }; return {}; }),
    notify: vi.fn(async () => true),
    gitHead: async () => 'abc123',
    readPrdTexts: async () => new Map(),
    audit: vi.fn(),
    mutateRows: async () => {},
    ...over,
  };
}

describe('applyPlanReviewHolds', () => {
  it('holds all members, creates one review PRD, and a second tick creates none', async () => {
    const state = { jobs: mk() };
    const d = deps();
    const held = await sched.applyPlanReviewHolds(state, d);
    expect([...held.keys()].sort()).toEqual(['1-a', '2-b', '3-c']);
    expect(d.createPrd).toHaveBeenCalledTimes(1);
    expect(d.createPrd.mock.calls[0][0].slug).toBe('plan-review-validate');
    expect(d.createPrd.mock.calls[0][0].implementationNotes).toContain('Base: abc123');
    // the created row now exists in the queue → no second creation
    state.jobs.push(row('plan-review-validate', { agentType: 'plan-reviewer' }));
    await sched.applyPlanReviewHolds(state, d);
    expect(d.createPrd).toHaveBeenCalledTimes(1);
    const { batch } = pickNextBatch(state.jobs, new Set(), 5, { heldSlugs: held, now: T0 });
    expect(batch.map((j) => j.slug)).not.toContain('1-a');
  });

  it('dispatches after a release record', async () => {
    const state = { jobs: mk() };
    const d = deps({ reviews: { '90-validate': { release: { by: 'planner' }, reviews: [{ at: '2026-01-01T00:05:00Z' }] } } });
    const held = await sched.applyPlanReviewHolds(state, d);
    expect(held.size).toBe(0);
    expect(d.createPrd).not.toHaveBeenCalled();
  });

  it('timeout releases once and notifies once', async () => {
    const state = { jobs: mk() };
    const reviews = {};
    const d = deps({ now: T0 + 5 * 3600 * 1000, reviews });
    const held = await sched.applyPlanReviewHolds(state, d);
    expect(held.size).toBe(0);
    expect(d.recordRelease).toHaveBeenCalledWith(expect.objectContaining({ by: 'timeout', validateSlug: '90-validate' }));
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][2]).toMatch(/PLAN REVIEW TIMED OUT — released without review/);
    expect(d.audit).toHaveBeenCalledWith('plan_review_timeout', expect.any(Object));
    await sched.applyPlanReviewHolds(state, d);
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  it('creates round 2 once on rereviewRequested', async () => {
    const state = { jobs: mk() };
    const d = deps({ reviews: { '90-validate': { rereviewRequested: true, reviews: [{ at: '2026-01-01T00:05:00Z' }] } } });
    state.jobs.push(row('plan-review-validate', { status: 'completed' }));
    await sched.applyPlanReviewHolds(state, d);
    expect(d.createPrd.mock.calls.map((c) => c[0].slug)).toEqual(['plan-review-validate-r2']);
  });
});

describe('known wait', () => {
  const heldRows = () => mk().map((r) => (['1-a', '2-b', '3-c'].includes(r.slug) ? { ...r, heldReason: 'held: plan-review — waiting' } : r));

  it('epic settle treats the hold like a preflight hold', () => {
    const r = evaluateEpicSettle({ epicId: EPIC, cwd: '/p', events: [], jobs: heldRows(), now: Date.now() });
    expect(JSON.stringify(r)).toContain('held: plan-review');
  });

  it('starveRootFor counts it as a known wait', () => {
    const rows = heldRows().filter((r) => r.agentType !== 'validator');
    expect(sched.starveRootFor(rows, '1-a').knownWait).toBe(true);
  });
});
