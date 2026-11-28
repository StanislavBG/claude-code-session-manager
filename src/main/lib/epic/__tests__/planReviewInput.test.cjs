import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const { buildPlanReviewInput, structuralFindings } = require('../planReviewInput.cjs');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/plan-review-defects.json'), 'utf8'));

describe('planReviewInput', () => {
  it('flags the unordered README doc PRD', () => {
    const f = structuralFindings(fx.members);
    expect(f).toEqual([expect.objectContaining({ check: 'doc-after-code', slug: '04-readme' })]);
  });

  it('flags a dependsOn outside the plan', () => {
    const f = structuralFindings([{ slug: 'a', goal: 'build', files: ['x.cjs'], dependsOn: ['ghost'] }]);
    expect(f.map((x) => x.check)).toEqual(['depends-on']);
  });

  it('builds the input with the criteria text and member details', () => {
    const input = buildPlanReviewInput({ ...fx, cwd: '/p', round: 1 });
    expect(input).toMatchObject({
      slug: 'plan-review-validate-launcher', agentType: 'plan-reviewer', tag: 'build',
      gate: ['none'], sourcePromptId: 'epic-fixture',
    });
    // The structured output is the only deliverable: no artifact, no file, no record criterion.
    expect(input.files).toBeUndefined();
    expect(input.deliverable).toBeUndefined();
    expect(input.artifactPaths).toBeUndefined();
    expect(input.acceptanceCriteria).toEqual([
      ...fx.members.map((m) => `Review ${m.slug}`),
      'Return the review as the structured output object only; write no file — the scheduler saves the record (01-validate-launcher.plan-review.json) from it',
    ]);
    expect(JSON.stringify(input)).not.toContain('.plan-review.md');
    expect(JSON.stringify(input)).not.toContain('Record written at');
    expect(input.implementationNotes).toContain('Deliverable: the structured output object (PLAN_REVIEW_SCHEMA) only. Write no file; the scheduler saves the review.');
    const n = input.implementationNotes;
    expect(n).toContain(fx.epicGoal);
    expect(n).toContain('Base: abc1234');
    expect(n).toContain('Structural pre-check:');
    for (const m of fx.members) {
      expect(n).toContain(m.slug);
      expect(n).toContain(m.prdPath);
      for (const c of m.acceptanceCriteria) expect(n).toContain(c);
    }
    expect(input.acceptanceCriteria).toContain('Review 03-launch-demo');
    expect(input.disposition).toBe('new-head');
    expect(input.dependsOn).toBeUndefined();
    expect(buildPlanReviewInput({ ...fx, cwd: '/p', round: 2 }).disposition).toBe('new-head');
    expect(buildPlanReviewInput({ ...fx, cwd: '/p', round: 2 }).slug).toBe('plan-review-validate-launcher-r2');
  });

  it('persona names the checks covering (a) and (b)', () => {
    const p = fs.readFileSync(path.join(__dirname, '../../../../seed/agents/plan-reviewer.md'), 'utf8');
    expect(p).toContain('vacuous-by-sibling');
    expect(p).toContain('failure-path');
  });
});
