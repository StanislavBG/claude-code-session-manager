// validationQuality — pure calculator: first-pass VERIFIED share, REFUTED share,
// fix waves per plan, escapes, and a 7-day miss report, per project.
import { test, expect } from 'vitest';
const { computeValidationQuality, PROPOSED_CHECKS } = require('../validationQuality.cjs');
const { MISS_KINDS } = require('../validatorVerdictSchema.cjs');

const DAY = 24 * 60 * 60 * 1000;
const CWD = '/p/self';
const T0 = Date.parse('2026-11-19T00:00:00Z');

const v = (prdSlug, validation, at, extra = {}) => ({ kind: 'response', validation, prdSlug, at, ...extra });
const row = (slug, extra = {}) => ({ cwd: CWD, epicId: 'e1', agentType: 'dev-lead', dependsOn: [], createdAt: T0, ...extra });
const withSlug = (slug, extra) => ({ ...row(slug, extra), slug });

function one(input) {
  const r = computeValidationQuality(input);
  expect(r.projects).toHaveLength(1);
  return r.projects[0];
}

test('exports one proposed check sentence per miss kind', () => {
  for (const k of MISS_KINDS) expect(typeof PROPOSED_CHECKS[k]).toBe('string');
  expect(Object.keys(PROPOSED_CHECKS)).toEqual([...MISS_KINDS]);
  expect(PROPOSED_CHECKS['not-checked-live']).toBe(
    'Before VERIFIED on a UI or data change, run it against real data or the live page and cite that output as evidence.',
  );
});

test('empty input gives no projects; a project with no data gives zeros and nulls', () => {
  expect(computeValidationQuality({ epics: [], rows: [], nowMs: T0 })).toEqual({ projects: [] });
  const p = one({ epics: [{ cwd: CWD, epicId: 'e1', events: [] }], rows: [], nowMs: T0 });
  expect(p).toMatchObject({
    cwd: CWD,
    project: 'self',
    firstPass: { pct: null, prds: [] },
    refuted: { pct: null, prds: [] },
    fixWaves: { perPlan: null, plans: [] },
    escapes: [],
  });
  expect(p.week.topMiss).toBeNull();
  expect(Object.values(p.week.missKinds).every((n) => n === 0)).toBe(true);
});

test('a PRD re-verified after REFUTED counts as refuted, not first-pass', () => {
  const p = one({
    epics: [{ cwd: CWD, epicId: 'e1', events: [
      v('1-a', 'refuted', T0, { missKinds: ['gate-red'] }),
      v('1-a', 'verified', T0 + 1000),
      v('2-b', 'verified', T0),
      v('3-validate-x', 'verified', T0), // validator slugs never count
    ] }],
    rows: [withSlug('1-a'), withSlug('2-b'), withSlug('3-validate-x', { agentType: 'validator', dependsOn: ['1-a', '2-b'] })],
    nowMs: T0 + DAY,
  });
  expect(p.firstPass).toEqual({ pct: 50, prds: ['b'] });
  expect(p.refuted).toEqual({ pct: 50, prds: ['a'] });
});

test('percentages round to one decimal and slugs dedupe by bare slug', () => {
  const p = one({
    epics: [{ cwd: CWD, epicId: 'e1', events: [
      v('1-a', 'verified', T0), v('a', 'verified', T0 + 1),
      v('2-b', 'refuted', T0), v('3-c', 'refuted', T0),
    ] }],
    rows: [],
    nowMs: T0 + DAY,
  });
  expect(p.firstPass).toEqual({ pct: 33.3, prds: ['a'] });
  expect(p.refuted).toEqual({ pct: 66.7, prds: ['b', 'c'] });
});

// Self, 2026-11-19: 950-956 VERIFIED by 957; fixes 959-960 (validated by 961)
// name 950 and 955; a later wave 962-964 (validated by 965) names 959 after
// 961 VERIFIED it.
function selfCase() {
  const work = [950, 951, 952, 953, 954, 955, 956].map((n) => `${n}-feat-${n}`);
  const events = work.map((s) => v(s, 'verified', T0 + 1000, { validator: '957-validate-feat' }));
  events.push(
    v('959-fix-950', 'verified', T0 + 3 * 3600e3, { validator: '961-validate-fix' }),
    v('960-fix-955', 'verified', T0 + 3 * 3600e3, { validator: '961-validate-fix' }),
  );
  const rows = [
    ...work.map((s) => withSlug(s)),
    withSlug('957-validate-feat', { agentType: 'validator', dependsOn: work }),
    withSlug('959-fix-950', { fixes: ['950-feat-950'], createdAt: T0 + 2 * 3600e3, missKind: 'not-checked-live', reason: 'empty list on real data' }),
    withSlug('960-fix-955', { fixes: ['feat-955'], createdAt: new Date(T0 + 2 * 3600e3).toISOString(), missKind: 'not-checked-live' }),
    withSlug('961-validate-fix', { agentType: 'validator', dependsOn: ['959-fix-950', '960-fix-955'], createdAt: T0 + 2 * 3600e3 }),
    withSlug('962-fix-959', { fixes: ['959-fix-950'], createdAt: T0 + 5 * 3600e3, missKind: 'regression' }),
    withSlug('963-more', { createdAt: T0 + 5 * 3600e3 }),
    withSlug('964-more-2', { createdAt: T0 + 5 * 3600e3 }),
    withSlug('965-validate-wave2', { agentType: 'validator', dependsOn: ['962-fix-959', '963-more', '964-more-2'], createdAt: T0 + 5 * 3600e3 }),
    withSlug('970-validate-sweep-e1', { agentType: 'validator', dependsOn: ['951-feat-951'] }),
  ];
  return { epics: [{ cwd: CWD, epicId: 'e1', events }], rows, nowMs: T0 + DAY };
}

test("Self's 2026-11-19 case: 3 escapes and its fix waves attributed to plan 957", () => {
  const input = selfCase();
  const first = one({ ...input, rows: input.rows.filter((r) => !/^96[2-5]-/.test(r.slug)) });
  expect(first.escapes).toHaveLength(2);
  expect(first.fixWaves).toEqual({ perPlan: 1, plans: [{ plan: 'validate-feat', fixWaves: ['validate-fix'] }] });

  const p = one(input);
  expect(p.escapes).toEqual([
    { fixPrd: 'fix-950', escapedPrd: 'feat-950', verifiedBy: '957-validate-feat', missKind: 'not-checked-live', reason: 'empty list on real data', at: T0 + 2 * 3600e3 },
    { fixPrd: 'fix-955', escapedPrd: 'feat-955', verifiedBy: '957-validate-feat', missKind: 'not-checked-live', reason: null, at: T0 + 2 * 3600e3 },
    { fixPrd: 'fix-959', escapedPrd: 'fix-950', verifiedBy: '961-validate-fix', missKind: 'regression', reason: null, at: T0 + 5 * 3600e3 },
  ]);
  expect(p.fixWaves.plans).toEqual([{ plan: 'validate-feat', fixWaves: ['validate-fix', 'validate-wave2'] }]);
  expect(p.fixWaves.perPlan).toBe(2);
  expect(p.firstPass.prds).toHaveLength(9);
  expect(p.week.topMiss).toMatchObject({ missKind: 'not-checked-live', count: 2, prds: ['feat-950', 'feat-955'], reasons: ['empty list on real data'], proposal: PROPOSED_CHECKS['not-checked-live'] });
});

test('a fix for a REFUTED or never-judged PRD is not an escape', () => {
  const p = one({
    epics: [{ cwd: CWD, epicId: 'e1', events: [
      v('1-a', 'verified', T0), v('1-a', 'refuted', T0 + 10, { missKinds: ['behavior-wrong'] }),
    ] }],
    rows: [
      withSlug('2-fix-a', { fixes: ['1-a'], createdAt: T0 + 20 }),
      withSlug('3-fix-b', { fixes: ['never-judged'], createdAt: T0 + 20 }),
      withSlug('4-fix-c', { fixes: ['1-a'] , createdAt: undefined }), // no creation time: skipped
      withSlug('5-fix-d', { fixes: ['1-a'], createdAt: T0 }), // verdict at == creation: not strictly before
    ],
    nowMs: T0 + DAY,
  });
  expect(p.escapes).toEqual([]);
});

test('row creation time falls back to enqueuedAt then issuedAt', () => {
  const p = one({
    epics: [{ cwd: CWD, epicId: 'e1', events: [v('1-a', 'verified', T0)] }],
    rows: [
      withSlug('2-fix-a', { fixes: ['a'], createdAt: undefined, enqueuedAt: new Date(T0 + 5).toISOString() }),
      withSlug('3-fix-a2', { fixes: ['a'], createdAt: undefined, issuedAt: T0 + 6 }),
    ],
    nowMs: T0 + DAY,
  });
  expect(p.escapes.map((e) => [e.fixPrd, e.at, e.verifiedBy, e.missKind])).toEqual([
    ['fix-a', T0 + 5, null, 'other'],
    ['fix-a2', T0 + 6, null, 'other'],
  ]);
});

test('week window: (nowMs - 7d, nowMs], ties broken by MISS_KINDS order', () => {
  const now = T0 + 10 * DAY;
  const p = one({
    epics: [{ cwd: CWD, epicId: 'e1', events: [
      v('1-old', 'refuted', now - 7 * DAY, { missKinds: ['security'] }), // on the open edge: out
      v('2-edge', 'refuted', now, { missKinds: ['security'], reason: 'r2' }), // on the closed edge: in
      v('3-future', 'refuted', now + 1, { missKinds: ['security'] }), // after now: out
      v('4-gate', 'refuted', now - DAY, { missKinds: ['gate-red'], reason: 'r4' }),
      v('5-inside', 'refuted', new Date(now - 7 * DAY + 1).toISOString(), { missKinds: ['made-up'] }),
    ] }],
    rows: [],
    nowMs: now,
  });
  expect(p.week.fromMs).toBe(now - 7 * DAY);
  expect(p.week.toMs).toBe(now);
  expect(p.week.missKinds).toMatchObject({ security: 1, 'gate-red': 1, other: 1 });
  // gate-red precedes security in MISS_KINDS
  expect(p.week.topMiss).toEqual({ missKind: 'gate-red', count: 1, prds: ['gate'], reasons: ['r4'], proposal: PROPOSED_CHECKS['gate-red'] });
});

test('projects are bucketed per cwd', () => {
  const r = computeValidationQuality({
    epics: [
      { cwd: '/p/b', epicId: 'x', events: [v('a', 'verified', T0)] },
      { cwd: '/p/a', epicId: 'y', events: [v('a', 'refuted', T0)] },
    ],
    rows: [],
    nowMs: T0 + 1,
  });
  expect(r.projects.map((p) => [p.project, p.firstPass.pct, p.refuted.pct])).toEqual([['a', 0, 100], ['b', 100, 0]]);
});
