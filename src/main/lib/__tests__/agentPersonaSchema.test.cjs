/**
 * agentPersonaSchema.test.cjs — unit tests for the canonical Agent persona
 * WRITE-path zod schema and its assertValidAgentPersonaSave fail-closed
 * helper.
 *
 * Agent is the third entity in the Agent/WorkType/Epic/PRD/Job ERD to get a
 * boundary schema — Epic (promptSessionSchema.cjs) and Job
 * (scheduleJobSchema.cjs) each got theirs only after a production incident;
 * this one closes the gap proactively before Agent has had its own.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/agentPersonaSchema.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  AgentPersonaSaveSchema,
  assertValidAgentPersonaSave,
} = require('../agentPersonaSchema.cjs');

function validPersona(overrides = {}) {
  return {
    name: 'code-reviewer',
    description: 'Reviews diffs for correctness and style.',
    tools: ['Read', 'Grep', 'Glob'],
    model: 'inherit',
    color: 'blue',
    tags: ['feature', 'bug'],
    projects: ['*'],
    action: '/develop\n\nReview the current diff.',
    actionLabel: 'Review',
    title: 'Engineering — Code Reviewer',
    body: 'You are a meticulous code reviewer.',
    ...overrides,
  };
}

test('a valid full persona parses', () => {
  const full = validPersona();
  expect(() => assertValidAgentPersonaSave(full)).not.toThrow();
  expect(AgentPersonaSaveSchema.safeParse(full).success).toBe(true);
});

test('a persona with an unknown tag is rejected', () => {
  const badTag = validPersona({ tags: ['feature', 'not-a-real-worktype'] });
  expect(() => assertValidAgentPersonaSave(badTag)).toThrow(/tags/);
});

test('a persona with an uppercase/spaced name is rejected', () => {
  const badName = validPersona({ name: 'Code Reviewer' });
  expect(() => assertValidAgentPersonaSave(badName)).toThrow(/name/);
});

test('a persona with only the required fields parses', () => {
  const minimal = {
    name: 'minimal-agent',
    description: '',
    tools: [],
    model: 'inherit',
    color: '',
    tags: [],
    body: '',
  };
  expect(() => assertValidAgentPersonaSave(minimal)).not.toThrow();
  expect(AgentPersonaSaveSchema.safeParse(minimal).success).toBe(true);
});
