/**
 * classifyTranscriptLine.test.cjs — unit tests for src/main/lib/classifyTranscriptLine.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/classifyTranscriptLine.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const {
  classifyLine,
  trimContentArray,
  makeRaw,
  buildPreviewText,
  MAX_RAW_STR,
  PREVIEW_CHARS,
  EXEMPT_TYPES,
} = require('../lib/classifyTranscriptLine.cjs');

test('classifyLine returns [] for non-object input', () => {
  expect(classifyLine(null)).toEqual([]);
  expect(classifyLine('not an object')).toEqual([]);
});

test('classifyLine tags usage events', () => {
  const [ev] = classifyLine({ usage: { input_tokens: 10, output_tokens: 5 } });
  expect(ev.kind).toBe('usage');
  expect(ev.data).toEqual({ input_tokens: 10, output_tokens: 5 });
});

test('classifyLine tags TodoWrite tool_use as todo_write', () => {
  const [ev] = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'x' }] } }] },
  });
  expect(ev.kind).toBe('todo_write');
  expect(ev.data).toEqual([{ content: 'x' }]);
});

test('classifyLine tags ExitPlanMode as plan', () => {
  const [ev] = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'do things' } }] },
  });
  expect(ev.kind).toBe('plan');
});

test('classifyLine tags Agent/Task tool_use as agent_spawn with toolUseId', () => {
  const [ev] = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'Agent', id: 'tool-1', input: { description: 'do work' } }] },
  });
  expect(ev.kind).toBe('agent_spawn');
  expect(ev.data.toolUseId).toBe('tool-1');
});

test('classifyLine tags generic tool_use blocks', () => {
  const [ev] = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tool-2', input: { command: 'ls' } }] },
  });
  expect(ev.kind).toBe('tool_use');
  expect(ev.data).toEqual({ name: 'Bash', input: { command: 'ls' }, id: 'tool-2' });
});

test('classifyLine tags tool_result blocks with toolUseId', () => {
  const [ev] = classifyLine({
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
  });
  expect(ev.kind).toBe('tool_result');
  expect(ev.data).toEqual({ toolUseId: 'tool-1' });
});

test('classifyLine falls back to message kind for non-array content', () => {
  const [ev] = classifyLine({ type: 'assistant', message: { content: 'hello' } });
  expect(ev.kind).toBe('assistant');
});

test('CORE: a content array of [text, tool_use, tool_use] emits exactly 3 events, not 1', () => {
  const events = classifyLine({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'doing two things' },
        { type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls' } },
        { type: 'tool_use', name: 'Bash', id: 'tu-2', input: { command: 'pwd' } },
      ],
    },
  });
  expect(events).toHaveLength(3);
  expect(events[0].kind).toBe('assistant'); // text block inherits the message's own type
  expect(events[0].data).toBe('doing two things');
  expect(events[1].kind).toBe('tool_use');
  expect(events[1].data.id).toBe('tu-1');
  expect(events[2].kind).toBe('tool_use');
  expect(events[2].data.id).toBe('tu-2');
});

test('CORE: a message carrying both usage AND non-empty content emits the usage event AND the content event(s)', () => {
  const events = classifyLine({
    type: 'assistant',
    usage: { input_tokens: 100, output_tokens: 40 },
    message: { content: [{ type: 'text', text: 'hello' }] },
  });
  expect(events).toHaveLength(2);
  expect(events.map((e) => e.kind).sort()).toEqual(['assistant', 'usage']);
  const usageEv = events.find((e) => e.kind === 'usage');
  expect(usageEv.data).toEqual({ input_tokens: 100, output_tokens: 40 });
  const textEv = events.find((e) => e.kind === 'assistant');
  expect(textEv.data).toBe('hello');
});

test('unknown/future content block types are surfaced, not dropped', () => {
  const events = classifyLine({
    type: 'assistant',
    message: { content: [{ type: 'server_tool_use', id: 'x', input: {} }] },
  });
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe('content_server_tool_use');
  expect(events[0].data).toEqual({ type: 'server_tool_use', id: 'x', input: {} });
});

test('trimContentArray passes through non-array input', () => {
  expect(trimContentArray('not-an-array')).toBe('not-an-array');
});

test('trimContentArray truncates long text fields past MAX_RAW_STR', () => {
  const longText = 'a'.repeat(MAX_RAW_STR + 100);
  const [block] = trimContentArray([{ type: 'text', text: longText }]);
  expect(block.text.length).toBe(MAX_RAW_STR + 1);
  expect(block.text.endsWith('…')).toBe(true);
});

test('trimContentArray now trims tool_use/tool_result blocks too (EXEMPT_TYPES is empty — orchestrator.ts/race.ts, the sole prior consumers, were deleted 2026-07-30)', () => {
  expect(EXEMPT_TYPES.size).toBe(0);
  const longText = 'a'.repeat(MAX_RAW_STR + 100);
  const [block] = trimContentArray([{ type: 'tool_use', text: longText }]);
  expect(block.text.length).toBe(MAX_RAW_STR + 1);
  expect(block.text.endsWith('…')).toBe(true);
});

test('makeRaw builds a projection from message content', () => {
  const raw = makeRaw({ message: { content: [{ type: 'text', text: 'hi' }] } });
  expect(raw.message.content).toEqual([{ type: 'text', text: 'hi' }]);
});

test('CORE: makeRaw preserves every top-level field on the line, not just message.content', () => {
  const line = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }] },
    attributionSkill: 'develop',
    attributionPlugin: 'session-manager-dev',
    attributionMcpServer: 'some-server',
    attributionMcpTool: 'some_tool',
    effort: 'high',
    gitBranch: 'main',
    isSidechain: false,
    isMeta: true,
    requestId: 'req-123',
    isApiErrorMessage: false,
    interruptedByShutdown: false,
    permissionMode: 'default',
    promptSource: 'user',
    toolUseResult: { ok: true },
  };
  const raw = makeRaw(line);
  for (const key of [
    'attributionSkill',
    'attributionPlugin',
    'attributionMcpServer',
    'attributionMcpTool',
    'effort',
    'gitBranch',
    'isSidechain',
    'isMeta',
    'requestId',
    'isApiErrorMessage',
    'interruptedByShutdown',
    'permissionMode',
    'promptSource',
    'toolUseResult',
  ]) {
    expect(raw[key]).toEqual(line[key]);
  }
});

test('CORE: every event carries a bounded previewText and, when a ref is passed, the ref survives untouched', () => {
  const ref = { filePath: '/tmp/fake.jsonl', byteOffset: 128, byteLength: 64 };
  const [ev] = classifyLine({ type: 'user', message: { content: 'a'.repeat(PREVIEW_CHARS + 500) } }, ref);
  expect(ev.ref).toEqual(ref);
  expect(ev.previewText.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
  expect(ev.previewText.endsWith('…')).toBe(true);
});

test('classifyLine omits ref (null) when the caller has no file context', () => {
  const [ev] = classifyLine({ usage: { input_tokens: 1, output_tokens: 1 } });
  expect(ev.ref).toBeNull();
});

test('buildPreviewText caps at PREVIEW_CHARS', () => {
  const s = buildPreviewText('x'.repeat(PREVIEW_CHARS + 50));
  expect(s.length).toBe(PREVIEW_CHARS + 1);
  expect(s.endsWith('…')).toBe(true);
});
