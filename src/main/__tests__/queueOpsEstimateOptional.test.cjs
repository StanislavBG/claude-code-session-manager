/**
 * queueOpsEstimateOptional.test.cjs — estimateMinutes is optional in the
 * queue linter; a present-but-malformed value is still flagged.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/queueOpsEstimateOptional.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lintOneAsync } = require('../queueOps.cjs');

async function lint(estimateLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lint-estimate-'));
  const p = path.join(dir, 'test-prd.md');
  fs.writeFileSync(p, `---\ntitle: "test"\ncwd: ~\n${estimateLine}---\n\n# Goal\n\nx\n`, 'utf8');
  const res = await lintOneAsync(p);
  return res.findings;
}

test('missing estimateMinutes produces no finding', async () => {
  expect(await lint('')).toEqual([]);
});

test('valid estimateMinutes produces no finding', async () => {
  expect(await lint('estimateMinutes: 15\n')).toEqual([]);
});

for (const bad of ['abc', '0', '-3']) {
  test(`malformed estimateMinutes "${bad}" is flagged`, async () => {
    const findings = await lint(`estimateMinutes: ${bad}\n`);
    expect(findings.map((f) => f.rule)).toEqual(['bad-estimate']);
    expect(findings[0].snippet).toContain('must be a positive integer');
  });
}
