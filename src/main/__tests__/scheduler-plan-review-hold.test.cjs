'use strict';

// Run: timeout 300 npx vitest run src/main/__tests__/scheduler-plan-review-hold.test.cjs

import { describe, it, expect, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    readEpicGoal: () => 'Ship the widget\n\nMake it fast',
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
    const notes = d.createPrd.mock.calls[0][0].implementationNotes;
    expect(notes).toContain('Ship the widget');
    expect(notes).toMatch(/PRD file: \/.*\/prds\/1-a\.md/);
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

describe('create refused audit', () => {
  it('audits once per (validateSlug, round) across ticks, again on a new round', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-plan-review-'));
    try {
      fs.mkdirSync(path.join(root, 'session-manager-operations'), { recursive: true });
      const rows = () => mk().map((r) => ({ ...r, cwd: root }));
      const d = deps({
        readReview: undefined,
        createPrd: vi.fn(async () => ({ ok: false, error: 'refused' })),
      });
      delete d.readReview;
      d.audit = vi.fn();
      const realStore = require('../lib/scheduler/planReviewStore.cjs');
      d.markCreateRefused = (c, e, s, r) => realStore.markCreateRefused(c, e, s, r);
      const state = { jobs: rows() };
      await sched.applyPlanReviewHolds(state, d);
      await sched.applyPlanReviewHolds(state, d);
      const count = () => d.audit.mock.calls.filter((c) => c[0] === 'plan_review_create_refused').length;
      expect(d.createPrd).toHaveBeenCalledTimes(2);
      expect(count()).toBe(1);
      // round 2 requested
      const rec = realStore.readPlanReview(root, EPIC, '90-validate');
      expect(rec.createRefusedLogged).toEqual([1]);
      await realStore.savePlanReviewResult({ cwd: root, epicId: EPIC, validateSlug: '90-validate', round: 1, reviewer: 'r', runId: 'x', model: 'm', review: {} });
      const p = realStore.planReviewPath(root, EPIC, '90-validate');
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
      cur.rereviewRequested = true;
      fs.writeFileSync(p, JSON.stringify(cur));
      await sched.applyPlanReviewHolds(state, d);
      await sched.applyPlanReviewHolds(state, d);
      expect(count()).toBe(2);
      expect(realStore.readPlanReview(root, EPIC, '90-validate').createRefusedLogged).toEqual([1, 2]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('default readEpicGoal without a title', () => {
  it('uses the first goalText paragraph plus the objective', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-plan-review-'));
    try {
      const ops = path.join(root, 'session-manager-operations');
      fs.mkdirSync(path.join(ops, 'prompt-sessions'), { recursive: true });
      fs.writeFileSync(path.join(ops, 'prompt-sessions', 'active-index.json'), JSON.stringify({
        sessions: { [EPIC]: { id: EPIC, goalText: 'FIRST-PARA line\n\nSECOND-PARA', openingPrompt: 'OBJ-MARKER' } },
      }));
      return (async () => {
        const state = { jobs: mk().map((r) => ({ ...r, cwd: root })) };
        const d = deps({ readEpicGoal: undefined, readReview: () => null, markCreateRefused: async () => true });
        delete d.readEpicGoal;
        await sched.applyPlanReviewHolds(state, d);
        const notes = d.createPrd.mock.calls[0][0].implementationNotes;
        expect(notes).toContain('FIRST-PARA line');
        expect(notes).not.toContain('SECOND-PARA');
        expect(notes).toContain('OBJ-MARKER');
      })().finally(() => fs.rmSync(root, { recursive: true, force: true }));
    } catch (e) { fs.rmSync(root, { recursive: true, force: true }); throw e; }
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

describe('default readers against a temp project', () => {
  it('goal carries title + objective and an archived member gets its real prds-archived path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-plan-review-'));
    try {
      const ops = path.join(root, 'session-manager-operations');
      fs.mkdirSync(path.join(ops, 'prompt-sessions'), { recursive: true });
      fs.writeFileSync(path.join(ops, 'prompt-sessions', 'active-index.json'), JSON.stringify({
        sessions: { [EPIC]: { id: EPIC, title: 'Widget epic', openingPrompt: 'OBJECTIVE-MARKER make it fast', goalText: 'Widget epic' } },
      }));
      const e = path.join(ops, 'scheduler', 'epics', EPIC);
      fs.mkdirSync(path.join(e, 'prds'), { recursive: true });
      fs.mkdirSync(path.join(e, 'prds-archived'), { recursive: true });
      const prd = (t) => `---\ntitle: ${t}\n---\n# Goal\nx\n`;
      fs.writeFileSync(path.join(e, 'prds', '1-a.md'), prd('A'));
      fs.writeFileSync(path.join(e, 'prds-archived', '2-b.md'), prd('B'));
      fs.writeFileSync(path.join(e, 'prds', '3-c.md'), prd('C'));
      const r = (slug, extra = {}) => ({ slug, status: 'pending', cwd: root, sourcePromptId: EPIC, dependsOn: [], ...extra });
      const state = { jobs: [r('1-a'), r('2-b'), r('3-c'),
        r('90-validate', { agentType: 'validator', planReview: 'required', dependsOn: ['a', 'b', 'c'], createdAt: '2026-01-01T00:00:00Z' })] };
      const d = deps({ readEpicGoal: undefined, readPrdTexts: undefined, resolvePrdPath: undefined, readReview: () => null });
      delete d.readEpicGoal; delete d.readPrdTexts; delete d.resolvePrdPath;
      await sched.applyPlanReviewHolds(state, d);
      expect(d.createPrd).toHaveBeenCalledTimes(1);
      const notes = d.createPrd.mock.calls[0][0].implementationNotes;
      expect(notes).toContain('OBJECTIVE-MARKER');
      expect(notes).toContain('Widget epic');
      expect(notes).toContain(path.join(e, 'prds-archived', '2-b.md'));
      expect(notes).toContain(path.join(e, 'prds', '1-a.md'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
