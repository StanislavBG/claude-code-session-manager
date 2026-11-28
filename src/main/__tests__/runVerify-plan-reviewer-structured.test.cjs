/**
 * runVerify-plan-reviewer-structured.test.cjs — a plan-reviewer run's
 * deliverable is its PLAN_REVIEW_SCHEMA structured output, not a commit or a
 * SCHEDULER_VERDICT line. An object with a `prds` array must verify
 * `pass_no_commit_plan_review` (harvestPlanReview validates the schema and
 * saves a malformed review as failed); a missing object, a non-array `prds`,
 * or the same object from another persona, must not.
 */
import { test, beforeAll, afterAll, vi } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRun } = require('../runVerify.cjs');

let writeSpy;
beforeAll(() => {
  writeSpy = vi.spyOn(require('../config.cjs'), 'writeJsonSync').mockImplementation((abs, data) => {
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
    return { ok: true, mtimeMs: 0 };
  });
});
afterAll(() => writeSpy.mockRestore());

const VALID = {
  prds: [
    { prd: '01-a', decision: 'ok', findings: [] },
    { prd: '02-b', decision: 'amend', findings: [{ severity: 'Minor', check: 'edge-case', text: 'cover empty input' }] },
  ],
  planFindings: [],
};

function writeLog(dir, slug, structuredOutput) {
  const result = { type: 'result', subtype: 'success', result: 'review done' };
  if (structuredOutput !== undefined) result.structured_output = structuredOutput;
  const lines = [
    '[scheduler] starting ' + slug + ' at 2026-11-28T00:00:00.000Z',
    JSON.stringify(result),
    '[scheduler] exit code=0 (raw code=0 signal=null) duration=47s',
  ];
  fs.writeFileSync(path.join(dir, `${slug}.log`), lines.join('\n') + '\n');
}

async function run({ agentType, structuredOutput }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-plan-reviewer-'));
  try {
    const slug = '5042-plan-review-validate-x';
    writeLog(tmp, slug, structuredOutput);
    const prdPath = path.join(tmp, `${slug}.md`);
    fs.writeFileSync(prdPath, `---\ntitle: Plan review\ncwd: /tmp\nagentType: ${agentType}\n---\n# Body\n`);
    return await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', agentType, cwd: tmp },
      allJobs: [],
      exitCode: 0,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('(a) plan-reviewer with a structured review verifies pass_no_commit_plan_review', { timeout: 10_000 }, async () => {
  const v = await run({ agentType: 'plan-reviewer', structuredOutput: VALID });
  assert.equal(v.verdict, 'pass_no_commit_plan_review');
  assert.equal(v.downgradeTo ?? null, null);
});

test('(a2) a malformed-but-array review still completes so harvest saves it as failed', { timeout: 10_000 }, async () => {
  const v = await run({ agentType: 'plan-reviewer', structuredOutput: { prds: [{ prd: '10-a' }], planFindings: [] } });
  assert.equal(v.verdict, 'pass_no_commit_plan_review');
  assert.equal(v.downgradeTo ?? null, null);
});

test('(b) plan-reviewer with no structured output stays no_verdict_sentinel', { timeout: 10_000 }, async () => {
  const v = await run({ agentType: 'plan-reviewer', structuredOutput: undefined });
  assert.equal(v.verdict, 'no_verdict_sentinel');
  assert.equal(v.downgradeTo, 'needs_review');
});

test('(c) plan-reviewer with an invalid structured output is not clean', { timeout: 10_000 }, async () => {
  const v = await run({ agentType: 'plan-reviewer', structuredOutput: { prds: 'x' } });
  assert.equal(v.verdict, 'no_verdict_sentinel');
});

test('(d) dev-lead with the same valid object stays no_verdict_sentinel', { timeout: 10_000 }, async () => {
  const v = await run({ agentType: 'dev-lead', structuredOutput: VALID });
  assert.equal(v.verdict, 'no_verdict_sentinel');
  assert.equal(v.downgradeTo, 'needs_review');
});
