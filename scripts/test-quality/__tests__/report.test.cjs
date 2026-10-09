/**
 * report.test.cjs — one scenario: synthetic map + smells produce every verdict
 * and one consolidate cluster.
 *
 * Run: timeout 120 npx vitest run scripts/test-quality/__tests__/report.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { attribute } = require('../coverage-map.cjs');
const { classify, clusters, summarize, renderMarkdown } = require('../report.cjs');

const cov = (src, s, b = []) => ({ [src]: { s, b } });
const entry = (coverage, passed = true) => ({ passed, timedOut: !passed, durationMs: 100, coverage });

test('every verdict + a consolidate cluster from a synthetic map', () => {
  const map = {
    headSha: 'abc',
    files: {
      'a/bloat.test.cjs': entry(cov('src/x.js', ['1', '2'])),
      'a/merge1.test.cjs': entry(cov('src/x.js', ['1', '2', '10'])),
      'a/merge2.test.cjs': entry(cov('src/x.js', ['1', '2', '11'])),
      'a/review.test.cjs': entry(cov('src/y.js', ['20', '21', '22', '23', '24', '25'])),
      'a/keep.test.cjs': entry(cov('src/z.js', ['30', '31', '32', '33', '34', '35'])),
      'a/broken.test.cjs': entry({}, false),
    },
  };
  const row = (file, smells = [], loc = 10) => ({ file, tests: 2, expects: 2, loc, smells });
  const smells = {
    files: [
      row('a/bloat.test.cjs', [], 50),
      row('a/merge1.test.cjs', ['micro-file']),
      row('a/merge2.test.cjs'),
      row('a/review.test.cjs', ['no-assert']),
      row('a/keep.test.cjs'),
      row('a/broken.test.cjs'),
      row('tests/e2e/flow.spec.ts'),
    ],
  };
  const attribution = attribute(map);
  const rows = classify({ smells, attribution, map });
  expect(Object.fromEntries(rows.map((r) => [r.file, r.verdict]))).toEqual({
    'a/bloat.test.cjs': 'bloat',
    'a/merge1.test.cjs': 'merge',
    'a/merge2.test.cjs': 'merge',
    'a/review.test.cjs': 'review',
    'a/keep.test.cjs': 'keep',
    'a/broken.test.cjs': 'unmeasured',
    'tests/e2e/flow.spec.ts': 'keep',
  });
  expect(rows.find((r) => r.file === 'tests/e2e/flow.spec.ts').reasons).toEqual(['e2e-not-measured']);

  const cl = clusters(attribution, map, rows);
  const flagged = cl.filter((c) => c.consolidate);
  expect(flagged.map((c) => c.src)).toEqual(['src/x.js']);
  expect(flagged[0].mergeOrBloat).toBe(3);

  const md = renderMarkdown({ headSha: 'abc', totals: summarize(rows), files: rows, clusters: cl });
  expect(md).toContain(
    'Totals: files=7 tests=14 loc=110 | keep=2 review=1 merge=2 bloat=1 unmeasured=1 | bloat+merge: loc=70 duration=0.3s',
  );
  expect(md).toContain('| a/bloat.test.cjs | 50 |');
  expect(md).toContain('| src/x.js | 3 | 3 |');
  expect(md).toContain('- no-assert: 1');
});
