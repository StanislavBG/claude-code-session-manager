/**
 * coverage-map.test.cjs — end-to-end run of the real CLI on two small test
 * files, plus a pure check of attribute().
 *
 * Run: timeout 300 npx vitest run scripts/test-quality/__tests__/coverage-map.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { attribute } = require('../coverage-map.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(REPO_ROOT, 'scripts/test-quality/coverage-map.cjs');
const A = 'src/main/lib/__tests__/atomicFs.test.cjs';
const B = 'src/main/lib/__tests__/queueStoreAtomicWrite.test.cjs';

test('CLI maps two real test files and attributes unique coverage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-map-test-'));
  try {
    const out = path.join(dir, 'map.json');
    const env = { ...process.env };
    for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'VITEST_MODE']) delete env[k];
    execFileSync('node', [CLI, A, B, '--jobs', '2', '--out', out], {
      cwd: REPO_ROOT,
      env,
      stdio: 'pipe',
    });
    const map = JSON.parse(fs.readFileSync(out, 'utf8'));
    // queueStore.cjs does not import atomicFs.cjs (it has its own tmp+rename), so B's
    // covered source is queueStore.cjs, not atomicFs.cjs.
    const expectedSrc = { [A]: 'src/main/lib/atomicFs.cjs', [B]: 'src/main/lib/queueStore.cjs' };
    for (const f of [A, B]) {
      expect(map.files[f].passed).toBe(true);
      expect(Object.keys(map.files[f].coverage)).toContain(expectedSrc[f]);
    }
    const attr = attribute(map);
    for (const f of [A, B]) {
      const covered = new Set();
      for (const [src, c] of Object.entries(map.files[f].coverage)) {
        for (const k of c.s) covered.add(`${src}|${k}`);
      }
      expect(attr[f].coveredS).toBe(covered.size);
      expect(attr[f].uniqueS).toBeLessThanOrEqual(attr[f].coveredS);
      expect(attr[f].uniqueB).toBeLessThanOrEqual(attr[f].coveredB);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 180000);

test('attribute() counts keys covered by no other test file', () => {
  const entry = (cov) => ({ passed: true, timedOut: false, durationMs: 5, coverage: cov });
  const map = {
    files: {
      't1.test.cjs': entry({ 'src/x.cjs': { s: ['1:0', '2:0', '3:0'], b: ['1:0:0', '1:0:1'] } }),
      't2.test.cjs': entry({
        'src/x.cjs': { s: ['2:0', '4:0'], b: ['1:0:0'] },
        'src/y.cjs': { s: ['1:0'], b: [] },
      }),
      't3.test.cjs': entry({ 'src/x.cjs': { s: ['1:0', '2:0'], b: ['1:0:1'] } }),
    },
  };
  const r = attribute(map);
  expect(r['t1.test.cjs']).toMatchObject({ coveredS: 3, coveredB: 2, uniqueS: 1, uniqueB: 0 });
  expect(r['t2.test.cjs']).toMatchObject({ coveredS: 3, coveredB: 1, uniqueS: 2, uniqueB: 0 });
  expect(r['t3.test.cjs']).toMatchObject({ coveredS: 2, coveredB: 1, uniqueS: 0, uniqueB: 0 });
});
