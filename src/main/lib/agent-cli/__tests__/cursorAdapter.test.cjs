'use strict';
import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const cursor = require('../adapters/cursor.cjs');
const ev = require('../agentCliEvents.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'cursor-stream.jsonl');
const SID = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';
const FLAGS = ['--print', '--output-format', 'stream-json', '--force', '--trust'];
const line = (o) => JSON.stringify(o);

function run(lines) {
  const p = cursor.createParser();
  const out = [];
  for (const l of lines) out.push(...p.push(l));
  out.push(...p.end({ exitCode: 0 }));
  return { p, out };
}

test('exports the adapter shape', () => {
  expect(cursor.id).toBe('cursor');
  for (const k of ['headlessSpawn', 'createParser', 'interactiveArgs']) expect(typeof cursor[k]).toBe('function');
});

test('headlessSpawn: prompt is the last positional argv entry, stdin empty', () => {
  expect(cursor.headlessSpawn({ prompt: 'hi' })).toEqual({ args: [...FLAGS, 'hi'], stdin: '' });
  expect(cursor.headlessSpawn({ prompt: 'hi', nativeSessionId: SID, model: 'gpt-5' }))
    .toEqual({ args: [...FLAGS, '--resume', SID, '--model', 'gpt-5', 'hi'], stdin: '' });
  expect(cursor.headlessSpawn({ prompt: 'hi', model: 'sonnet-4' }).args).toEqual([...FLAGS, '--model', 'sonnet-4', 'hi']);
});

test('headlessSpawn: oversize prompt returns an error naming the 120000-byte argv limit', () => {
  const ok = cursor.headlessSpawn({ prompt: 'a'.repeat(120000) });
  expect(ok.args).toHaveLength(FLAGS.length + 1);
  const r = cursor.headlessSpawn({ prompt: 'é'.repeat(60001) }); // 120002 bytes, 60001 chars
  expect(r.args).toBeUndefined();
  expect(typeof r.error).toBe('string');
  expect(r.error).toContain('120000');
});

test('interactiveArgs fresh and resume', () => {
  expect(cursor.interactiveArgs({})).toEqual(['--force']);
  expect(cursor.interactiveArgs({ model: 'm1' })).toEqual(['--force', '--model', 'm1']);
  expect(cursor.interactiveArgs({ nativeSessionId: SID, model: 'm1' })).toEqual(['--force', '--resume', SID, '--model', 'm1']);
});

test('fixture run translates to Claude stream-json events', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  const { p, out } = run(lines);
  expect(p.nativeSessionId()).toBe(SID);
  expect(out).toEqual([
    ev.initEvent(SID, 'cursor'),
    ev.textEvent("I'll read the README file."),
    ev.toolUseEvent({ id: 'toolu_read1', name: 'Read', input: { path: 'README.md' } }),
    ev.toolResultEvent({
      toolUseId: 'toolu_read1',
      content: JSON.stringify({ content: '# Project\n', isEmpty: false, exceededLimit: false, totalLines: 1, totalChars: 10 }),
      isError: false,
    }),
    ev.toolUseEvent({ id: 'toolu_write1', name: 'Write', input: { path: 'summary.txt', fileText: 'A project.', toolCallId: 'toolu_write1' } }),
    ev.toolResultEvent({
      toolUseId: 'toolu_write1',
      content: JSON.stringify({ path: '/tmp/proj/summary.txt', linesCreated: 1, fileSize: 10 }),
      isError: false,
    }),
    ev.textEvent(' Done.'),
    ev.resultEvent({ ok: true, text: "I'll read the README file. Done.", nativeSessionId: SID }),
  ]);
  expect(out.filter((e) => e.type === 'result')).toHaveLength(1);
  expect(out.some((e) => e.type === 'user' && e.message.content[0].type === 'text')).toBe(false);
});

test('tool name mapping, function tools and error results', () => {
  const p = cursor.createParser();
  const started = (call_id, tool_call) => p.push(line({ type: 'tool_call', subtype: 'started', call_id, tool_call }));
  expect(started('s', { shellToolCall: { args: { command: 'ls' } } })).toEqual([ev.toolUseEvent({ id: 's', name: 'Bash', input: { command: 'ls' } })]);
  expect(started('e', { editToolCall: { args: { path: 'x' } } })).toEqual([ev.toolUseEvent({ id: 'e', name: 'Edit', input: { path: 'x' } })]);
  expect(started('f', { function: { name: 'grep', arguments: '{"q":"a"}' } })).toEqual([ev.toolUseEvent({ id: 'f', name: 'grep', input: '{"q":"a"}' })]);
  expect(started('g', { globToolCall: { args: { pattern: '*' } } })).toEqual([ev.toolUseEvent({ id: 'g', name: 'globToolCall', input: { pattern: '*' } })]);
  expect(p.push(line({ type: 'tool_call', subtype: 'completed', call_id: 's', tool_call: { shellToolCall: { args: {}, result: { error: { message: 'denied' } } } } })))
    .toEqual([ev.toolResultEvent({ toolUseId: 's', content: JSON.stringify({ message: 'denied' }), isError: true })]);
});

test('result: failure, result-field fallback, exactly one result', () => {
  const p = cursor.createParser();
  p.push(line({ type: 'system', subtype: 'init', session_id: SID }));
  expect(p.push(line({ type: 'result', subtype: 'success', is_error: false, result: 'from field', session_id: SID })))
    .toEqual([ev.resultEvent({ ok: true, text: 'from field', nativeSessionId: SID })]);
  expect(p.push(line({ type: 'result', subtype: 'success', is_error: false, result: 'again' }))).toEqual([]);
  expect(p.end()).toEqual([]);
  const q = cursor.createParser();
  expect(q.push(line({ type: 'result', subtype: 'success', is_error: true, result: 'bad' })))
    .toEqual([ev.resultEvent({ ok: false, text: 'bad', nativeSessionId: undefined })]);
  const r = cursor.createParser();
  expect(r.push(line({ type: 'result', subtype: 'error', result: 'x' }))[0].is_error).toBe(true);
});

test('end() without a terminal event returns []; malformed/unknown lines ignored; push never throws', () => {
  const p = cursor.createParser();
  p.push(line({ type: 'system', subtype: 'init', session_id: SID }));
  for (const bad of ['not json', '{bad', '[]', '', null, undefined, 42, line({ type: 'mystery' }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    line({ type: 'tool_call', subtype: 'started' }), line({ type: 'assistant', message: null })]) {
    expect(() => p.push(bad)).not.toThrow();
    expect(p.push(bad)).toEqual([]);
  }
  expect(p.end()).toEqual([]);
});
