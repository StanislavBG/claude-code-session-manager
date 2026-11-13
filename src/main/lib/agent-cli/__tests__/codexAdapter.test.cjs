'use strict';
import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const codex = require('../adapters/codex.cjs');
const ev = require('../agentCliEvents.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-exec.jsonl');
const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const FLAGS = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];

function run(lines, exitCode = 0) {
  const p = codex.createParser();
  const out = [];
  for (const l of lines) out.push(...p.push(l));
  out.push(...p.end({ exitCode }));
  return { p, out };
}
const line = (o) => JSON.stringify(o);

test('exports the adapter shape', () => {
  expect(codex.id).toBe('codex');
  for (const k of ['headlessSpawn', 'createParser', 'interactiveArgs']) expect(typeof codex[k]).toBe('function');
});

test('headlessSpawn fresh: exec argv, prompt on stdin only', () => {
  const prompt = 'do the thing --secret';
  const r = codex.headlessSpawn({ prompt, claudeSessionId: 'c-1' });
  expect(r).toEqual({ args: ['exec', ...FLAGS, '-'], stdin: prompt });
  const m = codex.headlessSpawn({ prompt, claudeSessionId: 'c-1', model: 'gpt-5-codex' });
  expect(m.args).toEqual(['exec', ...FLAGS, '-m', 'gpt-5-codex', '-']);
  expect(m.args).not.toContain(prompt);
});

test('headlessSpawn resume: exec resume <id>', () => {
  const r = codex.headlessSpawn({ prompt: 'p', nativeSessionId: THREAD, claudeSessionId: 'c', model: 'o3' });
  expect(r).toEqual({ args: ['exec', 'resume', THREAD, ...FLAGS, '-m', 'o3', '-'], stdin: 'p' });
  expect(codex.headlessSpawn({ prompt: 'p', nativeSessionId: THREAD }).args)
    .toEqual(['exec', 'resume', THREAD, ...FLAGS, '-']);
});

test('interactiveArgs fresh and resume', () => {
  expect(codex.interactiveArgs({})).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  expect(codex.interactiveArgs({ model: 'o3' })).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-m', 'o3']);
  expect(codex.interactiveArgs({ nativeSessionId: THREAD, model: 'o3' }))
    .toEqual(['resume', THREAD, '--dangerously-bypass-approvals-and-sandbox', '-m', 'o3']);
  expect(codex.interactiveArgs({ nativeSessionId: THREAD }))
    .toEqual(['resume', THREAD, '--dangerously-bypass-approvals-and-sandbox']);
});

test('fixture run translates to the expected event sequence', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  const { p, out } = run(lines);
  expect(p.nativeSessionId()).toBe(THREAD);
  expect(out).toEqual([
    ev.initEvent(THREAD, 'codex'),
    ev.toolUseEvent({ id: 'item_1', name: 'Bash', input: { command: 'bash -lc ls' } }),
    ev.toolResultEvent({ toolUseId: 'item_1', content: 'README.md\nsrc\n', isError: false }),
    ev.textEvent('The repo has a README and a src folder.'),
    ev.textEvent('Done.'),
    ev.resultEvent({
      ok: true,
      text: 'The repo has a README and a src folder.\n\nDone.',
      usage: { input_tokens: 24763, output_tokens: 122, cache_read_input_tokens: 24448 },
      nativeSessionId: THREAD,
    }),
  ]);
  expect(out.filter((e) => e.type === 'result')).toHaveLength(1);
});

test('command_execution errors: non-zero exit_code or failed status', () => {
  const { out } = run([
    line({ type: 'item.completed', item: { id: 'a', type: 'command_execution', command: 'false', exit_code: 1, status: 'completed' } }),
    line({ type: 'item.completed', item: { id: 'b', type: 'command_execution', command: 'x', status: 'failed' } }),
  ]);
  const results = out.filter((e) => e.type === 'user').map((e) => e.message.content[0]);
  expect(results.map((r) => r.is_error)).toEqual([true, true]);
  // a completed-only item still gets its tool_use first
  expect(out[0]).toEqual(ev.toolUseEvent({ id: 'a', name: 'Bash', input: { command: 'false' } }));
});

test('file_change, mcp_tool_call, web_search, todo_list map to Claude tools; reasoning ignored', () => {
  const { out } = run([
    line({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hmm' } }),
    line({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }], status: 'completed' } }),
    line({ type: 'item.started', item: { id: 'm', type: 'mcp_tool_call', server: 'srv', tool: 'do_it', arguments: { x: 1 } } }),
    line({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'srv', tool: 'do_it', status: 'completed' } }),
    line({ type: 'item.started', item: { id: 'w', type: 'web_search', query: 'codex' } }),
    line({ type: 'item.started', item: { id: 't', type: 'todo_list', items: [{ text: 'a', completed: false }] } }),
  ]);
  const uses = out.filter((e) => e.type === 'assistant').map((e) => e.message.content[0]);
  expect(uses.map((u) => u.name)).toEqual(['Edit', 'mcp__srv__do_it', 'WebSearch', 'TodoWrite']);
  expect(uses[3].input).toEqual({ todos: [{ text: 'a', completed: false }] });
  const editResult = out[1].message.content[0];
  expect(editResult).toMatchObject({ type: 'tool_result', tool_use_id: 'f', is_error: false });
  expect(out.filter((e) => e.type === 'result')).toHaveLength(0);
});

test('turn.failed emits an error result with the message', () => {
  const { out } = run([
    line({ type: 'thread.started', thread_id: 't1' }),
    line({ type: 'turn.failed', error: { message: 'boom' } }),
  ], 1);
  const res = out.filter((e) => e.type === 'result');
  expect(res).toEqual([ev.resultEvent({ ok: false, text: 'boom', nativeSessionId: 't1' })]);
});

test('error event surfaces on end() only when no result was emitted', () => {
  const a = run([line({ type: 'error', message: 'stream lost' })], 1).out;
  expect(a).toEqual([ev.resultEvent({ ok: false, text: 'stream lost', nativeSessionId: undefined })]);
  const b = run([
    line({ type: 'error', message: 'retrying' }),
    line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 } }),
  ]).out;
  expect(b.filter((e) => e.type === 'result')).toHaveLength(1);
  expect(b.at(-1).subtype).toBe('success');
  const p = codex.createParser();
  expect(p.end({ exitCode: 0 })).toEqual([]);
});

test('second turn.completed does not emit a second result', () => {
  const { out } = run([
    line({ type: 'turn.completed', usage: {} }),
    line({ type: 'turn.completed', usage: {} }),
  ]);
  expect(out.filter((e) => e.type === 'result')).toHaveLength(1);
});

test('malformed lines and unknown events are ignored; push never throws', () => {
  const p = codex.createParser();
  for (const bad of ['', 'not json', '[1,2]', '{"type":', 'null', '{"type":"mystery"}', '{"type":"item.completed"}',
    '{"type":"item.completed","item":null}', '{"type":"item.started","item":{"type":"command_execution"}}',
    '{"type":"thread.started","thread_id":5}', undefined, null, 42, {}]) {
    expect(() => p.push(bad)).not.toThrow();
  }
  expect(p.nativeSessionId()).toBe(null);
});
