/**
 * classifyTranscriptLine.test.cjs — unit tests for src/main/lib/classifyTranscriptLine.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/classifyTranscriptLine.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const { classifyLine, trimContentArray, makeRaw, MAX_RAW_STR, EXEMPT_TYPES } = require('../lib/classifyTranscriptLine.cjs');

test('classifyLine returns null for non-object input', () => {
  expect(classifyLine(null)).toBeNull();
  expect(classifyLine('not an object')).toBeNull();
});

test('classifyLine tags usage events', () => {
  const ev = classifyLine({ usage: { input_tokens: 10, output_tokens: 5 } });
  expect(ev.kind).toBe('usage');
  expect(ev.data).toEqual({ input_tokens: 10, output_tokens: 5 });
});

test('classifyLine tags TodoWrite tool_use as todo_write', () => {
  const ev = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'x' }] } }] },
  });
  expect(ev.kind).toBe('todo_write');
  expect(ev.data).toEqual([{ content: 'x' }]);
});

test('classifyLine tags ExitPlanMode as plan', () => {
  const ev = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'do things' } }] },
  });
  expect(ev.kind).toBe('plan');
});

test('classifyLine tags Agent/Task tool_use as agent_spawn with toolUseId', () => {
  const ev = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'Agent', id: 'tool-1', input: { description: 'do work' } }] },
  });
  expect(ev.kind).toBe('agent_spawn');
  expect(ev.data.toolUseId).toBe('tool-1');
});

test('classifyLine tags generic tool_use blocks', () => {
  const ev = classifyLine({
    message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tool-2', input: { command: 'ls' } }] },
  });
  expect(ev.kind).toBe('tool_use');
  expect(ev.data).toEqual({ name: 'Bash', input: { command: 'ls' }, id: 'tool-2' });
});

test('classifyLine tags tool_result blocks with toolUseId', () => {
  const ev = classifyLine({
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
  });
  expect(ev.kind).toBe('tool_result');
  expect(ev.data).toEqual({ toolUseId: 'tool-1' });
});

test('classifyLine falls back to message kind', () => {
  const ev = classifyLine({ type: 'assistant', message: { content: 'hello' } });
  expect(ev.kind).toBe('assistant');
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

test('trimContentArray leaves EXEMPT_TYPES blocks untouched', () => {
  expect(EXEMPT_TYPES.has('tool_result')).toBe(true);
  expect(EXEMPT_TYPES.has('tool_use')).toBe(true);
  const longText = 'a'.repeat(MAX_RAW_STR + 100);
  const [block] = trimContentArray([{ type: 'tool_use', text: longText }]);
  expect(block.text.length).toBe(longText.length);
});

test('makeRaw builds slim projection from message content', () => {
  const raw = makeRaw({ message: { content: [{ type: 'text', text: 'hi' }] } });
  expect(raw.message.content).toEqual([{ type: 'text', text: 'hi' }]);
});
