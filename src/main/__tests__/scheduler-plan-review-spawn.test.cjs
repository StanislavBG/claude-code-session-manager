'use strict';

// Run: timeout 300 npx vitest run src/main/__tests__/scheduler-plan-review-spawn.test.cjs

import { describe, it, expect } from 'vitest';
const sched = require('../scheduler.cjs');
const { PLAN_REVIEW_SCHEMA } = require('../lib/scheduler/planReviewSchema.cjs');
const { reviewerModelFor } = require('../scheduler/planReviewHold.cjs');

describe('plan-reviewer spawn args', () => {
  it('passes --json-schema PLAN_REVIEW_SCHEMA and a --model different from the planner', () => {
    const model = reviewerModelFor('sonnet', 'sonnet');
    const args = sched.buildClaudeSpawnArgs({
      model, effort: null, sessionId: 's1', resume: false, systemPrompt: 'x',
      toolScope: null, jsonSchema: PLAN_REVIEW_SCHEMA,
    });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(PLAN_REVIEW_SCHEMA));
  });

  it('finishProtocolFlagsFor takes isArtifactOnly from the PRD only; buildFinishProtocol reviewer finish text has the reviewer line, not the artifact line', () => {
    const { FINISH_PLAN_REVIEWER_LINE, FINISH_ARTIFACT_ONLY_VERDICT_LINE, FINISH_PLAN_REVIEWER_COMMIT_LINE } = sched;
    expect(sched.finishProtocolFlagsFor({ agentType: 'plan-reviewer' }, false)).toEqual({ isArtifactOnly: false, isValidator: false, isPlanReviewer: true });
    expect(sched.finishProtocolFlagsFor({ agentType: 'plan-reviewer' }, true).isArtifactOnly).toBe(true);
    const text = sched.buildFinishProtocol({ reviewInRun: false, isFixPlan: false, isArtifactOnly: false, isValidator: false, isPlanReviewer: true });
    expect(text).toContain(FINISH_PLAN_REVIEWER_LINE.trim());
    expect(text).not.toContain(FINISH_ARTIFACT_ONLY_VERDICT_LINE.trim());
    expect(text).not.toContain('deliverable: artifact');
    expect(text).toContain(FINISH_PLAN_REVIEWER_COMMIT_LINE.trim());
    const plain = sched.buildFinishProtocol({ reviewInRun: false });
    expect(plain).not.toContain(FINISH_PLAN_REVIEWER_COMMIT_LINE.trim());
  });
});
