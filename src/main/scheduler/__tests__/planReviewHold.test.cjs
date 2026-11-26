'use strict';

// Run: timeout 300 npx vitest run src/main/scheduler/__tests__/planReviewHold.test.cjs

import { describe, it, expect } from 'vitest';
const hold = require('../planReviewHold.cjs');
const { reviewerModelFor } = hold;

const row = (slug, extra = {}) => ({ slug, status: 'pending', cwd: '/p', dependsOn: [], ...extra });
const validator = (deps, extra = {}) => row('90-validate', {
  agentType: 'validator', planReview: 'required', dependsOn: deps, createdAt: '2026-01-01T00:00:00Z', ...extra,
});
const NOW = Date.parse('2026-01-01T01:00:00Z');
const HOUR = 3600 * 1000;
const plan3 = () => [row('1-a'), row('2-b'), row('3-c'), validator(['a', 'b', 'c'])];

describe('planReviewHold rules', () => {
  it('2-PRD independent plan is not held', () => {
    const rows = [row('1-a'), row('2-b'), validator(['a', 'b'])];
    const r = hold.computePlanReviewHolds(rows, {}, { now: NOW, holdMs: 4 * HOUR });
    expect(r.held.size).toBe(0);
    expect(r.needsReview).toEqual([]);
  });
  it('3-PRD plan is held and needs review', () => {
    const r = hold.computePlanReviewHolds(plan3(), {}, { now: NOW, holdMs: 4 * HOUR });
    expect([...r.held.keys()].sort()).toEqual(['1-a', '2-b', '3-c']);
    expect(r.held.get('1-a')).toMatch(/^held: plan-review/);
    expect(r.needsReview).toEqual(['90-validate']);
  });
  it('2-PRD chain is held', () => {
    const rows = [row('1-a'), row('2-b', { dependsOn: ['a'] }), validator(['b'])];
    const r = hold.computePlanReviewHolds(rows, {}, { now: NOW, holdMs: 4 * HOUR });
    expect(r.held.size).toBe(2);
  });
  it('released plan (record.release object) is not held', () => {
    const rec = { validate: { release: { at: '2026-01-01T00:30:00Z', reason: 'approved' } } };
    const r = hold.computePlanReviewHolds(plan3(), rec, { now: NOW, holdMs: HOUR });
    expect(r.held.size).toBe(0);
    expect(r.expired).toEqual([]);
  });
  it('release: null does not release', () => {
    const r = hold.computePlanReviewHolds(plan3(), { validate: { release: null } }, { now: NOW, holdMs: HOUR });
    expect(r.held.size).toBe(3);
  });
  it('expires after holdMs', () => {
    const r = hold.computePlanReviewHolds(plan3(), {}, { now: NOW + 5 * HOUR, holdMs: 4 * HOUR });
    expect(r.expired).toEqual(['90-validate']);
    const fresh = hold.computePlanReviewHolds(plan3(), {}, { now: NOW, holdMs: 4 * HOUR });
    expect(fresh.expired).toEqual([]);
  });
  it('ignores rows from another cwd', () => {
    const rows = [row('1-a'), row('2-b'), row('3-c', { cwd: '/other' }), validator(['a', 'b', 'c'])];
    const r = hold.computePlanReviewHolds(rows, {}, { now: NOW, holdMs: 4 * HOUR });
    expect(r.held.size).toBe(0);
  });
  it('never holds the reviewer row', () => {
    const rows = [
      row('1-a'), row('2-b'), row('3-c'),
      row('91-plan-review', { agentType: 'plan-reviewer', dependsOn: ['a', 'b', 'c'] }),
      validator(['a', 'b', 'c', '91-plan-review']),
    ];
    const r = hold.computePlanReviewHolds(rows, {}, { now: NOW, holdMs: 4 * HOUR });
    expect(r.held.has('91-plan-review')).toBe(false);
    expect(r.held.size).toBe(3);
  });
});

describe('reviewerModelFor', () => {
  it('keeps the persona model when it differs from the planner family', () => {
    expect(reviewerModelFor('sonnet', 'opus')).toBe('sonnet');
    expect(reviewerModelFor('opus', 'claude-sonnet-4-5')).toBe('opus');
    expect(reviewerModelFor('haiku', 'opus')).toBe('haiku');
  });
  it('flips to opus when persona is sonnet and planner is sonnet', () => {
    expect(reviewerModelFor('sonnet', 'claude-sonnet-5-5')).toBe('opus');
  });
  it('flips to sonnet for any other same-family collision', () => {
    expect(reviewerModelFor('opus', 'opus')).toBe('sonnet');
    expect(reviewerModelFor('claude-opus-4', 'opus')).toBe('sonnet');
    expect(reviewerModelFor('fable', 'fable')).toBe('sonnet');
  });
});
