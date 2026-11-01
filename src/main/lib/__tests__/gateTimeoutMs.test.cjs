/**
 * gateTimeoutMs.test.cjs — summed gate timeout, including shell-syntax gates.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gateTimeoutMs.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { gateTimeoutMs, resolveGate } = require('../scheduler/definitionOfDone.cjs');

const FENCE = '`'.repeat(3) + 'gate';
const CLOSE = '`'.repeat(3);
const prd = (...lines) => ['# Goal', '', 'x', '', FENCE, ...lines, CLOSE, ''].join('\n');
const sec = (text) => gateTimeoutMs(text) / 1000;

test('0 for none, null, empty and no gate', () => {
  expect(gateTimeoutMs(prd('none'))).toBe(0);
  expect(gateTimeoutMs('---\ngate: none\n---\n# Goal\n')).toBe(0);
  expect(gateTimeoutMs(null)).toBe(0);
  expect(gateTimeoutMs('')).toBe(0);
  expect(gateTimeoutMs('# Goal\n\nnothing here\n')).toBe(0);
});

test('units, default, quotes, && sums', () => {
  expect(sec(prd('timeout 20m npm test'))).toBe(1200);
  expect(sec(prd('timeout 2h a'))).toBe(7200);
  expect(sec(prd('timeout 1d a'))).toBe(86400);
  expect(sec(prd('timeout 45s a'))).toBe(45);
  expect(sec(prd("rg -n 'timeout 5' src/"))).toBe(300);
  expect(sec(prd('echo "timeout 5 x"'))).toBe(300);
  expect(sec(prd('timeout 300 a && timeout 120 b'))).toBe(420);
  expect(sec(prd('timeout 10 timeout 20 a'))).toBe(30);
});

test('acceptance-criteria gate still counts', () => {
  const text = '# Acceptance criteria\n\n- [ ] `timeout 300 npm run typecheck && timeout 60 npm run lint`\n';
  expect(sec(text)).toBe(360);
});

test('real gate 870', () => {
  const text = prd(
    'timeout 900 systemd-run --user --scope --quiet -p MemoryMax=2G -p MemorySwapMax=0 pnpm --filter @bilko/tandem-derby exec vitest run src/draw.test.ts',
    'timeout 900 pnpm --filter @bilko/tandem-derby test',
  );
  expect(sec(text)).toBe(1800);
});

test('real gate 873', () => {
  const text = prd('timeout 900 systemd-run --user --scope --quiet -p MemoryMax=4G -p MemorySwapMax=0 pnpm --filter @bilko/shell exec playwright test tests/derby-tracks.spec.ts');
  expect(sec(text)).toBe(900);
});

test('real gate 872-fix needs a shell and is still counted', () => {
  const pw = (n) => `timeout 850 systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 pnpm --filter @bilko/shell exec playwright test tests/${n}.spec.ts --reporter=line`;
  const text = prd(
    'test "$(ls apps/shell/tests/*.spec.ts | wc -l)" = "$(for s in action-bar kernel; do ls apps/shell/tests/$s.spec.ts; done | wc -l)"',
    pw('a'), pw('b'), pw('c'),
  );
  expect(resolveGate(text).sequence).toEqual([]);
  expect(sec(text)).toBe(2850);
});
