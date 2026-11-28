'use strict';

// Run: timeout 300 npx vitest run src/main/__tests__/scheduler-plan-review-spawn.test.cjs

import { describe, it, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
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

  it('spawnJob takes isArtifactOnly from the PRD only; reviewer finish text has the reviewer line, not the artifact line', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler.cjs'), 'utf8');
    const grab = (name) => {
      const m = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;').exec(src);
      return m[1];
    };
    const call = src.split('\n').find((l) => l.includes('finishProtocol: buildFinishProtocol({') && l.includes('isPlanReviewer'));
    expect(call).toMatch(/isArtifactOnly,/);
    expect(call).not.toContain("isArtifactOnly || job.agentType === 'plan-reviewer'");
    const text = sched.buildFinishProtocol({ reviewInRun: false, isFixPlan: false, isArtifactOnly: false, isValidator: false, isPlanReviewer: true });
    expect(text).toContain(grab('FINISH_PLAN_REVIEWER_LINE').trim());
    expect(text).not.toContain(grab('FINISH_ARTIFACT_ONLY_VERDICT_LINE').trim());
  });
});
