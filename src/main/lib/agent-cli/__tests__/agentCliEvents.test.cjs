'use strict';
import { test, expect } from 'vitest';
const ev = require('../agentCliEvents.cjs');

test('AGENT_CLI_IDS lists the six ids in order', () => {
  expect(ev.AGENT_CLI_IDS).toEqual(['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'opencode']);
});

test('isAgentCliId accepts known ids only', () => {
  for (const id of ev.AGENT_CLI_IDS) expect(ev.isAgentCliId(id)).toBe(true);
  for (const x of [undefined, null, '', 'Claude', 'gpt', 1, {}, ['codex']]) expect(ev.isAgentCliId(x)).toBe(false);
});

test('isNonClaudeAgentCli is true only for the five non-claude ids', () => {
  for (const id of ['codex', 'gemini', 'antigravity', 'cursor', 'opencode']) expect(ev.isNonClaudeAgentCli(id)).toBe(true);
  for (const x of [undefined, null, 'claude', 'unknown', '', 42, {}, ['codex']]) expect(ev.isNonClaudeAgentCli(x)).toBe(false);
});

test('initEvent builds a system/init event', () => {
  expect(ev.initEvent('sess-1', 'codex')).toEqual({ type: 'system', subtype: 'init', session_id: 'sess-1', agent_cli: 'codex' });
});

test('textEvent builds an assistant text event', () => {
  expect(ev.textEvent('hi')).toEqual({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
});

test('toolUseEvent builds an assistant tool_use event', () => {
  expect(ev.toolUseEvent({ id: 't1', name: 'Bash', input: { command: 'ls' } })).toEqual({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
  });
});

test('toolResultEvent builds a user tool_result event', () => {
  expect(ev.toolResultEvent({ toolUseId: 't1', content: 'ok', isError: false })).toEqual({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
  });
  expect(ev.toolResultEvent({ toolUseId: 't2', content: 'boom', isError: true }).message.content[0].is_error).toBe(true);
});

test('toolResultEvent truncates long strings to 4000 chars', () => {
  const block = ev.toolResultEvent({ toolUseId: 't', content: 'x'.repeat(5000), isError: false }).message.content[0];
  expect(block.content).toHaveLength(4000);
  const exact = ev.toolResultEvent({ toolUseId: 't', content: 'y'.repeat(4000) }).message.content[0];
  expect(exact.content).toHaveLength(4000);
});

test('toolResultEvent coerces non-string content with JSON.stringify', () => {
  expect(ev.toolResultEvent({ toolUseId: 't', content: { a: 1 } }).message.content[0].content).toBe('{"a":1}');
  expect(ev.toolResultEvent({ toolUseId: 't', content: 42 }).message.content[0].content).toBe('42');
  const big = ev.toolResultEvent({ toolUseId: 't', content: ['z'.repeat(5000)] }).message.content[0].content;
  expect(big).toHaveLength(4000);
});

test('resultEvent success shape', () => {
  expect(ev.resultEvent({ ok: true, text: 'done', nativeSessionId: 's', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } })).toEqual({
    type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  });
});

test('resultEvent error shape', () => {
  const r = ev.resultEvent({ ok: false, text: 'fail', nativeSessionId: 's' });
  expect(r.type).toBe('result');
  expect(r.subtype).toBe('error');
  expect(r.is_error).toBe(true);
  expect(r.result).toBe('fail');
  expect(r.session_id).toBe('s');
  expect(r.usage).toBeUndefined();
});

test('resultEvent keeps only finite non-negative usage numbers', () => {
  const r = ev.resultEvent({ ok: true, text: '', nativeSessionId: 's', usage: { input_tokens: -1, output_tokens: Infinity, cache_read_input_tokens: 3, extra: 9 } });
  expect(r.usage).toEqual({ cache_read_input_tokens: 3 });
  const r2 = ev.resultEvent({ ok: true, text: '', nativeSessionId: 's', usage: { input_tokens: NaN, output_tokens: '5' } });
  expect(r2.usage).toEqual({});
});

test('safeJsonLine parses JSON objects', () => {
  expect(ev.safeJsonLine('{"type":"x","n":1}')).toEqual({ type: 'x', n: 1 });
  expect(ev.safeJsonLine('  {"a":2}  \n')).toEqual({ a: 2 });
});

test('safeJsonLine returns null for blank, non-JSON, non-object and oversize input', () => {
  for (const x of ['', '   ', '\n', 'not json', '{bad', '[1,2]', '42', '"str"', 'null', 'true', undefined, null, 5, {}]) {
    expect(ev.safeJsonLine(x)).toBeNull();
  }
  const huge = '{"a":"' + 'x'.repeat(8 * 1024 * 1024) + '"}';
  expect(ev.safeJsonLine(huge)).toBeNull();
});
