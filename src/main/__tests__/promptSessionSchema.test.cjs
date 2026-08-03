/**
 * promptSessionSchema.test.cjs — unit tests for the canonical PromptSession
 * zod schema and its assertValidPromptSession fail-closed helper.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/promptSessionSchema.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { PromptSessionSchema, assertValidPromptSession } = require('../lib/promptSessionSchema.cjs');

test('a valid full record parses', () => {
  const full = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    goalText: 'do the thing',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'proposed',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
    resumedFromId: 'old-epic-id',
    tag: 'feature',
    openingPrompt: 'full body of the first prompt',
    source: {
      producer: 'rca-hook',
      prdSlug: '123-fix-thing',
      runId: 'run-1',
      sourceTabId: 'tab-1',
    },
    agentType: 'architect',
  };
  expect(() => assertValidPromptSession(full)).not.toThrow();
  expect(PromptSessionSchema.safeParse(full).success).toBe(true);
});

test('a valid minimal record (only required fields) parses', () => {
  const minimal = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    goalText: 'do the thing',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'active',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
  };
  expect(() => assertValidPromptSession(minimal)).not.toThrow();
});

test('missing a required field fails', () => {
  const missingGoalText = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'active',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
  };
  expect(() => assertValidPromptSession(missingGoalText)).toThrow(/goalText/);
});

test('an invalid status value fails', () => {
  const badStatus = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    goalText: 'do the thing',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'in-progress',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
  };
  expect(() => assertValidPromptSession(badStatus)).toThrow(/status/);
});

test('an invalid tag value fails', () => {
  const badTag = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    goalText: 'do the thing',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'active',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
    tag: 'not-a-real-tag',
  };
  expect(() => assertValidPromptSession(badTag)).toThrow(/tag/);
});

test('a source object missing its required producer fails', () => {
  const badSource = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    goalText: 'do the thing',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'active',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
    source: { prdSlug: '123-fix-thing' },
  };
  expect(() => assertValidPromptSession(badSource)).toThrow(/producer/);
});
