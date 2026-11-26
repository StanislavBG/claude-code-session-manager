/**
 * scriptStartedBy.test.cjs — CallerSchema, StartedBySchema, buildStartedBy and
 * the lenient stored/IPC round-trip.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/scriptStartedBy.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { CallerSchema, StartedBySchema, buildStartedBy } = require('../scriptStartedBy.cjs');
const { EpicSourceSchema } = require('../../promptSessionSchema.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');

test('valid caller accepted', () => {
  const c = { pipeline: 'p', runId: 'r', step: 's', attempt: 0 };
  expect(CallerSchema.parse(c)).toEqual(c);
});

test('unknown key, over-long pipeline, negative attempt rejected', () => {
  expect(CallerSchema.safeParse({ extra: 1 }).success).toBe(false);
  expect(CallerSchema.safeParse({ pipeline: 'x'.repeat(201) }).success).toBe(false);
  expect(CallerSchema.safeParse({ attempt: -1 }).success).toBe(false);
});

test('buildStartedBy omits empty keys', () => {
  expect(buildStartedBy({ route: '/admin/macros/run', caller: {}, fromCwd: '', fromEpicId: undefined }))
    .toEqual({ kind: 'script', route: '/admin/macros/run' });
  const full = buildStartedBy({ route: 'r', caller: { runId: 'x', step: '' }, fromCwd: '/a', fromEpicId: 'e' });
  expect(full).toEqual({ kind: 'script', route: 'r', caller: { runId: 'x' }, fromCwd: '/a', fromEpicId: 'e' });
  expect(StartedBySchema.safeParse(full).success).toBe(true);
});

test('startedBy round-trips through EpicSourceSchema and promptSessionsCreateEpic', () => {
  const source = { producer: 'new-epic-ui', startedBy: buildStartedBy({ route: '/admin/macros/run', fromCwd: '/p' }) };
  expect(EpicSourceSchema.parse(source).startedBy).toEqual(source.startedBy);
  const parsed = schemas.promptSessionsCreateEpic.parse({ cwd: '/p', goalText: 'g', source });
  expect(parsed.source.startedBy).toEqual(source.startedBy);
});

describe('startedByFromRequest', () => {
  const { startedByFromRequest } = require('../scriptStartedBy.cjs');
  const route = '/admin/macros/run';
  const caller = { runId: 'r1' };

  test('resolved Epic adds fromCwd + fromEpicId', async () => {
    const out = await startedByFromRequest({ route, caller, socket: {} }, {
      resolvePeerChatSession: async () => ({ chatSessionId: 'chat-12345678', projectRoot: '/p' }),
      findEpicByClaudeSessionId: (cwd, id) => (cwd === '/p' && id === 'chat-12345678' ? { id: 'epic-1' } : null),
    });
    expect(out).toEqual({ kind: 'script', route, caller, fromCwd: '/p', fromEpicId: 'epic-1' });
  });

  test('chat but no Epic', async () => {
    const out = await startedByFromRequest({ route, caller, socket: {} }, {
      resolvePeerChatSession: async () => ({ chatSessionId: 'chat-12345678', projectRoot: '/p' }),
      findEpicByClaudeSessionId: () => null,
    });
    expect(out).toEqual({ kind: 'script', route, caller });
  });

  test('no chat', async () => {
    const out = await startedByFromRequest({ route, socket: {} }, { resolvePeerChatSession: async () => null });
    expect(out).toEqual({ kind: 'script', route });
  });
});
