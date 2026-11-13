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
      producer: 'new-epic-ui',
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

test('a legacy bilko-host-publisher tag is dropped (treated as absent), never thrown', () => {
  const legacyTag = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    goalText: 'do the thing',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'active',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
    tag: 'bilko-host-publisher',
  };
  const result = assertValidPromptSession(legacyTag);
  expect(result.tag).toBeUndefined();
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

const devLoopBase = { id: 'epic-dl000001', cwd: '/tmp/x', goalText: 'g', claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000', status: 'proposed', createdAt: '2026-08-02T00:00:00.000Z', completedAt: null };

test('developLoop false is kept', () => {
  const r = PromptSessionSchema.safeParse({ ...devLoopBase, developLoop: false });
  expect(r.success).toBe(true);
  expect(r.data.developLoop).toBe(false);
});

test('developLoop as a string is rejected', () => {
  expect(PromptSessionSchema.safeParse({ ...devLoopBase, developLoop: 'no' }).success).toBe(false);
});

test('a row without developLoop parses unchanged', () => {
  const r = PromptSessionSchema.safeParse(devLoopBase);
  expect(r.success).toBe(true);
  expect('developLoop' in r.data).toBe(false);
});

const partBase = {
  id: 'epic-abc12345',
  cwd: '/home/bilko/Projects/session-manager',
  goalText: 'g',
  claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
  status: 'proposed',
  createdAt: '2026-08-02T00:00:00.000Z',
  completedAt: null,
};
const sec = (extra) => ({ ...partBase, sections: [{ kind: 'goal', label: 'Goal', text: 't', ...extra }] });

test('a section part is kept, not stripped', () => {
  const r = PromptSessionSchema.safeParse(sec({ part: 'goal' }));
  expect(r.success).toBe(true);
  expect(r.data.sections[0].part).toBe('goal');
});

test('a section without part still parses', () => {
  const r = PromptSessionSchema.safeParse(sec({}));
  expect(r.success).toBe(true);
  expect('part' in r.data.sections[0]).toBe(false);
});

test('a section with part bogus fails', () => {
  expect(PromptSessionSchema.safeParse(sec({ part: 'bogus' })).success).toBe(false);
});

test('agentCli + agentCliModel round-trip through PromptSessionSchema and the merge-active-index schema', () => {
  const { promptSessionsMergeActiveIndex } = require('../ipcSchemas.cjs').schemas;
  const base = {
    id: 'epic-abc12345',
    cwd: '/home/bilko/Projects/session-manager',
    goalText: 'do the thing',
    claudeSessionId: 'c1b2a3d4-0000-0000-0000-000000000000',
    status: 'proposed',
    createdAt: '2026-08-02T00:00:00.000Z',
    completedAt: null,
  };
  const codex = { ...base, agentCli: 'codex', agentCliModel: 'gpt-5.5' };
  const parsed = PromptSessionSchema.parse(codex);
  expect(parsed.agentCli).toBe('codex');
  expect(parsed.agentCliModel).toBe('gpt-5.5');

  // Not an enum: a row from a newer build naming an unknown CLI is kept.
  const future = { ...base, id: 'epic-def67890', agentCli: 'future-cli' };
  expect(PromptSessionSchema.parse(future).agentCli).toBe('future-cli');

  const merged = promptSessionsMergeActiveIndex.parse({
    cwd: base.cwd,
    sessions: { [codex.id]: codex, [future.id]: future },
    events: {},
    source: 'epics',
  });
  expect(merged.sessions[codex.id].agentCli).toBe('codex');
  expect(merged.sessions[codex.id].agentCliModel).toBe('gpt-5.5');
  expect(merged.sessions[future.id].agentCli).toBe('future-cli');
});
