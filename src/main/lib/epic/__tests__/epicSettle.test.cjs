'use strict';

import { test, expect } from 'vitest';
const { evaluateEpicSettle } = require('../epicSettle.cjs');

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const at = (min) => new Date(NOW - 3600_000 + min * 60_000).toISOString();
const checkin = (slug, min, extra = {}) => ({ kind: 'response', at: at(min), prdSlug: slug, outcome: 'completed', validation: 'unvalidated', ...extra });
const verdict = (bare, min, v = 'verified', text = '') => ({ kind: 'response', at: at(min), prdSlug: bare, validation: v, text });
const run = (events, jobs = []) => evaluateEpicSettle({ epicId: 'e1', cwd: '/p', events, jobs, now: NOW });

test('not settled while a pending row exists; other epics/cwds ignored', () => {
  expect(run([], [{ slug: '1-a', status: 'pending', epicId: 'e1' }]).settled).toBe(false);
  expect(run([], [{ slug: '1-a', status: 'running', sourcePromptId: 'e1', cwd: '/p' }]).settled).toBe(false);
  expect(run([], [{ slug: '1-a', status: 'pending', epicId: 'e2' }, { slug: '2-b', status: 'pending', epicId: 'e1', cwd: '/other' }]).settled).toBe(true);
});

test('starry-night-2 shape: 15 completed check-ins all later verified -> uncovered empty', () => {
  const events = [];
  for (let i = 1; i <= 15; i++) events.push(checkin(`${i}-thing${i}`, i));
  for (let i = 1; i <= 15; i++) events.push(verdict(`thing${i}`, 30 + i));
  const r = run(events);
  expect(r.uncovered).toEqual([]);
  expect(r.verified).toHaveLength(15);
  expect(r.hasContent).toBe(true);
});

test('uncovered completed PRD is reported with full and bare slug', () => {
  const r = run([checkin('7-foo', 1), checkin('8-bar', 2), verdict('bar', 3)]);
  expect(r.uncovered).toEqual([{ slug: '7-foo', bareSlug: 'foo' }]);
});

test('verdict older than the check-in does not cover it', () => {
  expect(run([verdict('foo', 1), checkin('7-foo', 2)]).uncovered).toHaveLength(1);
});

test('validator check-ins are excluded', () => {
  const r = run([checkin('9-x', 1, { agentType: 'validator' }), checkin('10-validate-plan', 2), checkin('11-validate-y', 3, { agentType: 'dev-lead' })]);
  expect(r.uncovered.map((u) => u.slug)).toEqual(['11-validate-y']);
});

test('failed and needs_review rows are reported; refuted reason parsed', () => {
  const r = run(
    [checkin('3-bad', 1, { outcome: 'failed' }), verdict('foo', 2, 'refuted', 'Validation REFUTED: foo — gate red')],
    [{ slug: '4-stuck', status: 'needs_review', epicId: 'e1' }],
  );
  expect(r.failed).toEqual(['3-bad']);
  expect(r.parked).toEqual(['4-stuck']);
  expect(r.refuted).toEqual([{ slug: 'foo', reason: 'gate red' }]);
});

test('window starts after the newest digest event', () => {
  const r = run([checkin('1-old', 1), { kind: 'response', at: at(5), outcome: 'digest', digestKey: 'k' }, checkin('2-new', 6)]);
  expect(r.uncovered.map((u) => u.slug)).toEqual(['2-new']);
  const old = run([{ ...checkin('1-ancient', 0), at: new Date(NOW - 48 * 3600_000).toISOString() }]);
  expect(old.uncovered).toEqual([]);
});

test('digestKey is 16 hex chars and stable under reordering', () => {
  const evs = [checkin('1-a', 1), checkin('2-b', 2), verdict('c', 3), checkin('4-d', 4, { outcome: 'failed' })];
  const a = run(evs).digestKey;
  expect(a).toMatch(/^[0-9a-f]{16}$/);
  expect(run([...evs].reverse()).digestKey).toBe(a);
  expect(run([]).hasContent).toBe(false);
});

test('never throws on bad input', () => {
  expect(() => evaluateEpicSettle({ epicId: 'e1', events: null, jobs: 'x' })).not.toThrow();
});
