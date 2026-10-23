// refireCap — pure decision: re-fire a verify-downgraded job, or park it once
// it has been downgraded too many times in a row (Bilko-Launch-Kit storm).
import { test, expect } from 'vitest';
const { MAX_CONSECUTIVE_VERIFY_REFIRES, decideVerifyDowngrade } = require('../refireCap.cjs');

const VR = { verdict: 'halt', reason: 'dep x is skipped' };

test('default cap is 2', () => {
  expect(MAX_CONSECUTIVE_VERIFY_REFIRES).toBe(2);
});

test('counts 0, 1, 2 with the default cap: refire, refire, park', () => {
  expect(decideVerifyDowngrade({}, VR)).toEqual({ action: 'refire', nextCount: 1 });
  expect(decideVerifyDowngrade({ verifyRefireCount: 1 }, VR)).toEqual({ action: 'refire', nextCount: 2 });
  const parked = decideVerifyDowngrade({ verifyRefireCount: 2 }, VR);
  expect(parked.action).toBe('park');
  expect(parked.nextCount).toBe(3);
  expect(parked.verdict).toBe('refire_capped');
});

test('malformed counts are treated as 0', () => {
  for (const bad of [undefined, null, -1, 1.5, NaN, '2', {}]) {
    expect(decideVerifyDowngrade({ verifyRefireCount: bad }, VR)).toEqual({ action: 'refire', nextCount: 1 });
  }
});

test('opts.cap overrides the default; cap below 0 acts as 0', () => {
  expect(decideVerifyDowngrade({ verifyRefireCount: 2 }, VR, { cap: 5 }).action).toBe('refire');
  expect(decideVerifyDowngrade({ verifyRefireCount: 0 }, VR, { cap: 0 }).action).toBe('park');
  expect(decideVerifyDowngrade({ verifyRefireCount: 0 }, VR, { cap: -3 }).action).toBe('park');
});

test('reason text is exact', () => {
  const d = decideVerifyDowngrade({ verifyRefireCount: 2 }, VR);
  expect(d.reason).toBe('re-fire cap: 3 consecutive post-run downgrades (halt: dep x is skipped)');
});

test('does not mutate inputs', () => {
  const job = Object.freeze({ verifyRefireCount: 2 });
  const vr = Object.freeze({ ...VR });
  const opts = Object.freeze({ cap: 2 });
  expect(() => decideVerifyDowngrade(job, vr, opts)).not.toThrow();
  expect(job).toEqual({ verifyRefireCount: 2 });
  expect(vr).toEqual(VR);
});
