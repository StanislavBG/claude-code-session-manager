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
});
