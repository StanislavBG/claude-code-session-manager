'use strict';
import { test, expect } from 'vitest';
const { selectAutoFixTargets } = require('../reviewLadder.cjs');

const base = { slug: '1313-x', status: 'needs_review', runId: 'r1', verifierVerdict: 'transcript_errors', cwd: '/x' };
const opts = { fixSlugExists: () => false };

test('selectAutoFixTargets skips a row stamped environmentLimit', () => {
  const stamped = { ...base, environmentLimit: { kind: 'unix-socket', evidence: 'e' } };
  expect(selectAutoFixTargets([base], opts).map((j) => j.slug)).toEqual(['1313-x']);
  expect(selectAutoFixTargets([stamped], opts)).toEqual([]);
});
