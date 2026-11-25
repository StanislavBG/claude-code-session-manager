/**
 * utilizationHold.test.cjs — evaluateAutoDispatchHold: the one rule deciding
 * whether an automatic scheduler tick may dispatch (manual fire policy, usage
 * threshold over every window of the last real reading, reset windows skipped).
 *
 * Run: timeout 120 npx vitest run src/main/scheduler/__tests__/utilizationHold.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const utilizationHold = require('../utilizationHold.cjs');

const NOW = Date.parse('2026-11-23T23:30:00Z');
// FUTURE and LATER sit more than a week ahead, so every window is read at the
// flat 'pause above' value (no pro-rating) in the cases below the pro-rate block.
const FUTURE = '2026-12-01T05:00:00Z';
const LATER = '2026-12-03T17:00:00Z';
const PAST = '2026-11-23T22:00:00Z';

function evalHold(args) {
  return utilizationHold.evaluateAutoDispatchHold({ firePolicy: 'auto', threshold: 90, now: NOW, ...args });
}
function single(percent, resetsAt = FUTURE, window = 'weekly_all') {
  return { percent, window, resetsAt, known: true, windows: null };
}

test('manual fire policy holds whatever the reading', () => {
  const expected = {
    reason: 'manual-fire-policy', window: null, percent: null, threshold: null, resetsAt: null,
    detail: 'fire policy is manual: only Run now dispatches',
  };
  expect(evalHold({ firePolicy: 'manual', reading: null })).toEqual(expected);
  expect(evalHold({ firePolicy: 'manual', reading: single(10) })).toEqual(expected);
  expect(evalHold({ firePolicy: 'manual', reading: single(99), threshold: NaN })).toEqual(expected);
});

test('null or undefined reading returns null', () => {
  expect(evalHold({ reading: null })).toBeNull();
  expect(evalHold({ reading: undefined })).toBeNull();
});

test('reading.known !== true returns null', () => {
  expect(evalHold({ reading: { ...single(99), known: false } })).toBeNull();
  expect(evalHold({ reading: { ...single(99), known: undefined } })).toBeNull();
});

test('non-finite threshold returns null', () => {
  expect(evalHold({ reading: single(99), threshold: NaN })).toBeNull();
  expect(evalHold({ reading: single(99), threshold: Infinity })).toBeNull();
  expect(evalHold({ reading: single(99), threshold: null })).toBeNull();
});

test('single reading at the threshold holds (90 at 90)', () => {
  expect(evalHold({ reading: single(90) })).toEqual({
    reason: 'utilization-held', window: 'weekly_all', percent: 90, threshold: 90, resetsAt: FUTURE,
    baseThreshold: 90,
    detail: `weekly_all window at 90% ≥ 90%, resets ${FUTURE}`,
  });
});

test('single reading just below the threshold does not hold (89.9 at 90)', () => {
  expect(evalHold({ reading: single(89.9) })).toBeNull();
});

test('detail uses binding and unknown for null window and resetsAt', () => {
  const r = evalHold({ reading: { percent: 95.5, window: null, resetsAt: null, known: true, windows: null } });
  expect(r).toMatchObject({ reason: 'utilization-held', window: null, percent: 95.5, resetsAt: null });
  expect(r.detail).toBe('binding window at 95.5% ≥ 90%, resets unknown');
});

test("Self's case: session reset, weekly_all still holds; then null after weekly reset", () => {
  const reading = {
    percent: 97, window: 'session', resetsAt: PAST, known: true,
    windows: [
      { window: 'session', percent: 97, resetsAt: PAST },
      { window: 'weekly_all', percent: 92, resetsAt: LATER },
    ],
  };
  const r = evalHold({ reading });
  expect(r).toMatchObject({ reason: 'utilization-held', window: 'weekly_all', percent: 92, resetsAt: LATER, threshold: 90 });
  expect(evalHold({ reading, now: Date.parse('2026-12-03T18:00:00Z') })).toBeNull();
});

test('a reset window above threshold plus a live window below gives null', () => {
  const reading = {
    ...single(97, PAST, 'session'),
    windows: [
      { window: 'session', percent: 97, resetsAt: PAST },
      { window: 'weekly_all', percent: 50, resetsAt: LATER },
    ],
  };
  expect(evalHold({ reading })).toBeNull();
});

test('a reset at exactly now is skipped', () => {
  expect(evalHold({ reading: single(99, new Date(NOW).toISOString()) })).toBeNull();
});

test('every candidate reset gives null', () => {
  const reading = {
    ...single(99, PAST),
    windows: [
      { window: 'session', percent: 99, resetsAt: PAST },
      { window: 'weekly_all', percent: 95, resetsAt: '2026-11-20T00:00:00Z' },
    ],
  };
  expect(evalHold({ reading })).toBeNull();
});

test('two holding windows name the one that resets later', () => {
  const reading = {
    ...single(0),
    windows: [
      { window: 'session', percent: 99, resetsAt: FUTURE },
      { window: 'weekly_all', percent: 91, resetsAt: LATER },
    ],
  };
  expect(evalHold({ reading })).toMatchObject({ window: 'weekly_all', percent: 91, resetsAt: LATER });
});

test('equal resets: the higher percent is named', () => {
  const reading = {
    ...single(0),
    windows: [
      { window: 'weekly_all', percent: 91, resetsAt: LATER },
      { window: 'weekly_opus', percent: 96, resetsAt: LATER },
      { window: 'other', percent: 93, resetsAt: LATER },
    ],
  };
  expect(evalHold({ reading })).toMatchObject({ window: 'weekly_opus', percent: 96 });
});

test('a window with a null resetsAt holds and is named (counts as last)', () => {
  const reading = {
    ...single(0),
    windows: [
      { window: 'weekly_all', percent: 99, resetsAt: LATER },
      { window: 'mystery', percent: 91, resetsAt: null },
    ],
  };
  const r = evalHold({ reading });
  expect(r).toMatchObject({ reason: 'utilization-held', window: 'mystery', percent: 91, resetsAt: null });
  expect(r.detail).toBe('mystery window at 91% ≥ 90%, resets unknown');
});

test('an unparseable resetsAt counts as not reset and as last', () => {
  const reading = {
    ...single(0),
    windows: [
      { window: 'weekly_all', percent: 99, resetsAt: LATER },
      { window: 'garbled', percent: 92, resetsAt: 'not-a-date' },
    ],
  };
  expect(evalHold({ reading })).toMatchObject({ window: 'garbled', resetsAt: 'not-a-date' });
});

test('an empty windows array falls back to the single reading', () => {
  expect(evalHold({ reading: { ...single(93), windows: [] } })).toMatchObject({
    reason: 'utilization-held', window: 'weekly_all', percent: 93,
  });
  expect(evalHold({ reading: { ...single(50), windows: [] } })).toBeNull();
});

test('a window with a non-finite percent is skipped', () => {
  const reading = {
    ...single(0),
    windows: [
      { window: 'session', percent: NaN, resetsAt: null },
      { window: 'weekly_all', percent: 92, resetsAt: LATER },
    ],
  };
  expect(evalHold({ reading })).toMatchObject({ window: 'weekly_all', percent: 92 });
  expect(evalHold({ reading: { ...single(0), windows: [{ window: 'x', percent: null, resetsAt: null }] } })).toBeNull();
});

test('single reading with non-finite percent returns null', () => {
  expect(evalHold({ reading: { ...single(0), percent: null } })).toBeNull();
});

test('windows take precedence over the top-level single reading', () => {
  const reading = { ...single(99), windows: [{ window: 'weekly_all', percent: 40, resetsAt: LATER }] };
  expect(evalHold({ reading })).toBeNull();
});

// ── Pro-rated threshold: rises with the share of the window elapsed ──
const H = 60 * 60 * 1000;
const DAY = 24 * H;
const at = (ms) => new Date(NOW + ms).toISOString();

test('pro-rate constants are exported', () => {
  expect(utilizationHold.PRO_RATE_CEILING).toBe(99);
  expect(utilizationHold.PRO_RATE_FULL_FRACTION).toBe(2 / 7);
  expect(utilizationHold.WINDOW_LENGTH_MS).toEqual({ weekly: 7 * DAY, fiveHour: 5 * H });
});

test('proRatedThreshold: weekly 7 days left -> base, 4.5 days -> 94.5, 41 h -> 99', () => {
  const pr = (left, window = 'weekly_all', base = 90) =>
    utilizationHold.proRatedThreshold({ base, window, resetsAt: at(left), now: NOW });
  expect(pr(7 * DAY)).toBe(90);
  expect(pr(8 * DAY)).toBe(90);
  expect(pr(4.5 * DAY)).toBeCloseTo(94.5, 9);
  expect(pr(41 * H)).toBe(99);
  expect(pr(2 * DAY)).toBe(99);
  expect(pr(4.5 * DAY, 'seven_day_opus')).toBeCloseTo(94.5, 9);
  expect(pr(4 * H, 'five_hour')).toBeCloseTo(92.52, 9);
  expect(pr(4 * H, 'session')).toBeCloseTo(92.52, 9);
  expect(pr(1 * H, 'five_hour')).toBe(99);
  expect(pr(4.5 * DAY, 'weekly_all', 99)).toBe(99);
  expect(pr(41 * H, 'weekly_all', 99)).toBe(99);
  expect(pr(4.5 * DAY, 'weekly_all', 100)).toBe(100);
  expect(pr(41 * H, 'weekly_all', 100)).toBe(100);
  expect(pr(41 * H, 'weekly_all', 120)).toBe(120);
});

test('proRatedThreshold: unknown window, missing/unparseable reset, non-finite base -> base', () => {
  const p = utilizationHold.proRatedThreshold;
  expect(p({ base: 90, window: 'mystery', resetsAt: at(H), now: NOW })).toBe(90);
  expect(p({ base: 90, window: null, resetsAt: at(H), now: NOW })).toBe(90);
  expect(p({ base: 90, window: 'weekly_all', resetsAt: null, now: NOW })).toBe(90);
  expect(p({ base: 90, window: 'weekly_all', resetsAt: 'not-a-date', now: NOW })).toBe(90);
  expect(p({ base: NaN, window: 'weekly_all', resetsAt: at(H), now: NOW })).toBeNaN();
  expect(p({ base: Infinity, window: 'weekly_all', resetsAt: at(H), now: NOW })).toBe(Infinity);
});

test('base 90, weekly_all with reset 41 h ahead: 82% and 98.9% run, 99% holds at 99', () => {
  const reset = at(41 * H);
  expect(evalHold({ reading: single(82, reset) })).toBeNull();
  expect(evalHold({ reading: single(98.9, reset) })).toBeNull();
  const r = evalHold({ reading: single(99, reset) });
  expect(r).toMatchObject({ reason: 'utilization-held', window: 'weekly_all', percent: 99, threshold: 99, baseThreshold: 90 });
  expect(r.detail).toBe(`weekly_all window at 99% ≥ 99% (pause above 90%, pro-rated: 1.7 days to reset), resets ${reset}`);
});

test('base 90, weekly_all 4.5 days left: 94 runs, 95 holds at 94.5', () => {
  expect(evalHold({ reading: single(94, at(4.5 * DAY)) })).toBeNull();
  const r = evalHold({ reading: single(95, at(4.5 * DAY)) });
  expect(r.threshold).toBeCloseTo(94.5, 9);
  expect(r.baseThreshold).toBe(90);
});

test('base 90, five_hour 95%: 4 h left holds (cap ~92.5), 1 h left runs', () => {
  const r = evalHold({ reading: single(95, at(4 * H), 'five_hour') });
  expect(r).toMatchObject({ reason: 'utilization-held', window: 'five_hour', percent: 95, baseThreshold: 90 });
  expect(r.threshold).toBeCloseTo(92.52, 9);
  expect(r.detail).toBe(`five_hour window at 95% ≥ 92.5% (pause above 90%, pro-rated: 4.0 h to reset), resets ${at(4 * H)}`);
  expect(evalHold({ reading: single(95, at(1 * H), 'five_hour') })).toBeNull();
});

test('base 100 holds only at 100 whatever the time left', () => {
  expect(evalHold({ threshold: 100, reading: single(99.9, at(41 * H)) })).toBeNull();
  expect(evalHold({ threshold: 100, reading: single(100, at(6 * DAY)) })).toMatchObject({ threshold: 100, baseThreshold: 100 });
});

test('each window uses its own effective limit', () => {
  const reading = {
    ...single(0),
    windows: [
      { window: 'five_hour', percent: 95, resetsAt: at(1 * H) }, // cap 99: runs
      { window: 'weekly_all', percent: 96, resetsAt: at(4.5 * DAY) }, // cap 94.5: holds
    ],
  };
  expect(evalHold({ reading })).toMatchObject({ window: 'weekly_all', percent: 96 });
});

// Real usage-API resets_at strings for the Thu 2026-11-26 17:00Z weekly reset
// (recorded 2026-11-23/24): the same reset jitters about ±0.5 s per fetch.
const JITTERED = [
  '2026-11-26T17:00:00.401695+00:00',
  '2026-11-26T17:00:00.301873+00:00',
  '2026-11-26T16:59:59.973643+00:00',
  '2026-11-26T16:59:59.539462+00:00',
];
function heldAt(resetsAt, window = 'weekly_all', reason = 'utilization-held') {
  return { reason, window, percent: 96, threshold: 90, resetsAt, detail: 'x' };
}

test('holdIdentityKey: jittered resets_at strings for one reset give one key', () => {
  const keys = new Set(JITTERED.map((r) => utilizationHold.holdIdentityKey(heldAt(r))));
  expect(keys.size).toBe(1);
  expect([...keys][0]).toBe('utilization-held|weekly_all|2026-11-26T17:00:00.000Z');
});

test('holdIdentityKey: a reset a minute away, another window or another reason differ', () => {
  const base = utilizationHold.holdIdentityKey(heldAt(JITTERED[0]));
  expect(utilizationHold.holdIdentityKey(heldAt('2026-11-26T17:01:00.401695+00:00'))).not.toBe(base);
  expect(utilizationHold.holdIdentityKey(heldAt('2026-11-26T16:59:00.000000+00:00'))).not.toBe(base);
  expect(utilizationHold.holdIdentityKey(heldAt(JITTERED[0], 'five_hour'))).not.toBe(base);
  expect(utilizationHold.holdIdentityKey(heldAt(JITTERED[0], 'weekly_all', 'manual-fire-policy'))).not.toBe(base);
});

test('holdIdentityKey: null and unparseable resetsAt give stable keys', () => {
  const manual = { reason: 'manual-fire-policy', window: null, resetsAt: null };
  expect(utilizationHold.holdIdentityKey(manual)).toBe('manual-fire-policy||');
  expect(utilizationHold.holdIdentityKey({ ...manual })).toBe(utilizationHold.holdIdentityKey(manual));
  expect(utilizationHold.holdIdentityKey(heldAt('not a date'))).toBe('utilization-held|weekly_all|not a date');
  expect(utilizationHold.holdIdentityKey(heldAt('not a date'))).toBe(utilizationHold.holdIdentityKey(heldAt('not a date')));
  expect(utilizationHold.holdIdentityKey({ reason: 'utilization-held' })).toBe('utilization-held||');
});
