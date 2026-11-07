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
 * Run: timeout 120 npx vitest run src/main/lib/persona-macro/__tests__/agentPersonaSchema.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  AgentPersonaSaveSchema,
  assertValidAgentPersonaSave,
  PersonaNameSchema,
  ProjectCwdSchema,
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

test('a legacy bilko-host-publisher tag is dropped from the tags array (treated as absent), never thrown', () => {
  const legacyTag = validPersona({ tags: ['feature', 'bilko-host-publisher', 'bug'] });
  const result = assertValidAgentPersonaSave(legacyTag);
  expect(result.tags).toEqual(['feature', 'bug']);
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

test('executorOnly is an optional boolean and survives parsing', () => {
  expect(assertValidAgentPersonaSave(validPersona({ executorOnly: true })).executorOnly).toBe(true);
  expect(assertValidAgentPersonaSave(validPersona()).executorOnly).toBeUndefined();
  expect(() => assertValidAgentPersonaSave(validPersona({ executorOnly: 'yes' }))).toThrow(/executorOnly/);
});

test('a save payload carrying projectName is rejected', () => {
  // The retired override key. .strict() REJECTS it instead of stripping it — a stripped override
  // key used to fall through to the GLOBAL write with the override call's blank description/body.
  const stale = validPersona({ projectName: 'alpha' });
  expect(AgentPersonaSaveSchema.safeParse(stale).success).toBe(false);
  expect(() => assertValidAgentPersonaSave(stale)).toThrow(/projectName/);
  expect(() => assertValidAgentPersonaSave(validPersona({ notAField: 1 }))).toThrow(/notAField/);
});

test('a relative projectCwd is rejected', () => {
  expect(() => assertValidAgentPersonaSave(validPersona({ projectCwd: 'work/alpha' }))).toThrow(/projectCwd/);
  expect(() => assertValidAgentPersonaSave(validPersona({ projectCwd: 'alpha' }))).toThrow(/projectCwd/);
  expect(() => assertValidAgentPersonaSave(validPersona({ projectCwd: '' }))).toThrow(/projectCwd/);
});

test('an absolute projectCwd parses and survives; omitted stays undefined', () => {
  expect(assertValidAgentPersonaSave(validPersona({ projectCwd: '/work/alpha' })).projectCwd).toBe('/work/alpha');
  expect(assertValidAgentPersonaSave(validPersona()).projectCwd).toBeUndefined();
});

test('PersonaNameSchema and ProjectCwdSchema are exported for the other agents:* payloads', () => {
  expect(PersonaNameSchema.safeParse('dev-lead').success).toBe(true);
  expect(PersonaNameSchema.safeParse('../dev-lead').success).toBe(false);
  expect(ProjectCwdSchema.safeParse('/work/alpha').success).toBe(true);
  expect(ProjectCwdSchema.safeParse('alpha').success).toBe(false);
  expect(ProjectCwdSchema.safeParse('').success).toBe(false);
  expect(ProjectCwdSchema.safeParse(`/${'a'.repeat(4096)}`).success).toBe(false);
});
