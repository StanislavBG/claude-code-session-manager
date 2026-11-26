'use strict';

// Run: timeout 300 npx vitest run src/main/scheduler/__tests__/planReviewHold.test.cjs

import { describe, it, expect } from 'vitest';
const { reviewerModelFor } = require('../planReviewHold.cjs');

describe('reviewerModelFor', () => {
  it('keeps the persona model when it differs from the planner family', () => {
    expect(reviewerModelFor('sonnet', 'opus')).toBe('sonnet');
    expect(reviewerModelFor('opus', 'claude-sonnet-4-5')).toBe('opus');
    expect(reviewerModelFor('haiku', 'opus')).toBe('haiku');
  });
  it('flips to opus when persona is sonnet and planner is sonnet', () => {
    expect(reviewerModelFor('sonnet', 'claude-sonnet-5-5')).toBe('opus');
  });
  it('flips to sonnet for any other same-family collision', () => {
    expect(reviewerModelFor('opus', 'opus')).toBe('sonnet');
    expect(reviewerModelFor('claude-opus-4', 'opus')).toBe('sonnet');
    expect(reviewerModelFor('fable', 'fable')).toBe('sonnet');
  });
});
