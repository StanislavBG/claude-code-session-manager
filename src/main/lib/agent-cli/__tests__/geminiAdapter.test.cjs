'use strict';
import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const gemini = require('../adapters/gemini.cjs');
const ev = require('../agentCliEvents.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'gemini-stream.jsonl');
const SID = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';
const CLAUDE_SID = '11111111-2222-4333-8444-555555555555';
const FLAGS = ['--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust'];
const line = (o) => JSON.stringify(o);

function run(lines) {
  const p = gemini.createParser();
  const out = [];
  for (const l of lines) out.push(...p.push(l));
  out.push(...p.end({ exitCode: 0 }));
  return { p, out };
}

test('exports the adapter shape', () => {
  expect(gemini.id).toBe('gemini');
  for (const k of ['headlessSpawn', 'createParser', 'interactiveArgs']) expect(typeof gemini[k]).toBe('function');
});

test('headlessSpawn fresh: --session-id <claudeSessionId>, prompt on stdin only', () => {
  const prompt = 'do it -p --resume';
  const r = gemini.headlessSpawn({ prompt, nativeSessionId: null, claudeSessionId: CLAUDE_SID });
  expect(r).toEqual({ args: [...FLAGS, '--session-id', CLAUDE_SID], stdin: prompt });
  const m = gemini.headlessSpawn({ prompt, nativeSessionId: null, claudeSessionId: CLAUDE_SID, model: 'gemini-2.5-pro' });
  expect(m.args).toEqual([...FLAGS, '--session-id', CLAUDE_SID, '-m', 'gemini-2.5-pro']);
  expect(m.args).not.toContain(prompt);
  expect(m.args).not.toContain('-p');
});

test('headlessSpawn resume: --resume <nativeSessionId>', () => {
  const r = gemini.headlessSpawn({ prompt: 'p', nativeSessionId: SID, claudeSessionId: CLAUDE_SID, model: 'flash' });
  expect(r).toEqual({ args: [...FLAGS, '--resume', SID, '-m', 'flash'], stdin: 'p' });
  expect(gemini.headlessSpawn({ prompt: 'p', nativeSessionId: SID }).args).toEqual([...FLAGS, '--resume', SID]);
});

test('interactiveArgs fresh and resume', () => {
  expect(gemini.interactiveArgs({ nativeSessionId: null, claudeSessionId: CLAUDE_SID }))
    .toEqual(['--approval-mode', 'yolo', '--session-id', CLAUDE_SID]);
  expect(gemini.interactiveArgs({ nativeSessionId: null, claudeSessionId: CLAUDE_SID, model: 'm1' }))
    .toEqual(['--approval-mode', 'yolo', '--session-id', CLAUDE_SID, '-m', 'm1']);
  expect(gemini.interactiveArgs({ nativeSessionId: SID, claudeSessionId: CLAUDE_SID, model: 'm1' }))
    .toEqual(['--approval-mode', 'yolo', '--resume', SID, '-m', 'm1']);
});

test('fixture run translates to Claude stream-json events', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  const { p, out } = run(lines);
  expect(p.nativeSessionId()).toBe(SID);
  expect(out).toEqual([
    ev.initEvent(SID, 'gemini'),
    ev.textEvent('Hello'),
    ev.textEvent(', I will'),
    ev.textEvent(' list the files.'),
    ev.toolUseEvent({ id: 'run_shell_command-1', name: 'run_shell_command', input: { command: 'ls' } }),
    ev.toolResultEvent({ toolUseId: 'run_shell_command-1', content: 'a.txt\nb.txt', isError: false }),
    ev.resultEvent({
      ok: true,
      text: 'Hello, I will list the files.',
      usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 300 },
      nativeSessionId: SID,
    }),
  ]);
  expect(out.filter((e) => e.type === 'result')).toHaveLength(1);
  expect(out.some((e) => e.type === 'user' && e.message.content[0].type === 'text')).toBe(false);
});

test('error run: tool error, error event, result status error', () => {
  const lines = [
    line({ type: 'init', timestamp: 't', session_id: SID, model: 'm' }),
    line({ type: 'tool_use', timestamp: 't', tool_name: 'read_file', tool_id: 'r1', parameters: { path: 'x' } }),
    line({ type: 'tool_result', timestamp: 't', tool_id: 'r1', status: 'error', output: '', error: { type: 'ENOENT', message: 'no such file' } }),
    line({ type: 'error', timestamp: 't', severity: 'error', message: 'quota exceeded' }),
    line({ type: 'result', timestamp: 't', status: 'error', error: { type: 'API', message: 'quota exceeded' }, stats: { input_tokens: 5, output_tokens: 0, cached: 0 } }),
  ];
  const { p, out } = run(lines);
  expect(p.nativeSessionId()).toBe(SID);
  expect(out).toEqual([
    ev.initEvent(SID, 'gemini'),
    ev.toolUseEvent({ id: 'r1', name: 'read_file', input: { path: 'x' } }),
    ev.toolResultEvent({ toolUseId: 'r1', content: 'no such file', isError: true }),
    ev.resultEvent({
      ok: false,
      text: 'quota exceeded',
      usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0 },
      nativeSessionId: SID,
    }),
  ]);
});

test('end(): synthesizes an error result from the last error when no result arrived', () => {
  const p = gemini.createParser();
  p.push(line({ type: 'init', session_id: SID }));
  p.push(line({ type: 'error', severity: 'warning', message: 'first' }));
  p.push(line({ type: 'error', severity: 'error', message: 'last' }));
  expect(p.end()).toEqual([ev.resultEvent({ ok: false, text: 'last', nativeSessionId: SID })]);
  expect(p.end()).toEqual([]);
  const q = gemini.createParser();
  q.push(line({ type: 'init', session_id: SID }));
  expect(q.end()).toEqual([]);
});

test('end() after result returns []; unknown/malformed lines ignored; push never throws', () => {
  const p = gemini.createParser();
  for (const bad of ['not json', '{bad', '[]', '', null, undefined, 42, line({ type: 'mystery' }), line({ type: 'message', role: 'user', content: 'hi' })]) {
    expect(() => p.push(bad)).not.toThrow();
    expect(p.push(bad)).toEqual([]);
  }
  p.push(line({ type: 'error', message: 'boom' }));
  expect(p.push(line({ type: 'result', status: 'success', stats: {} }))).toHaveLength(1);
  expect(p.push(line({ type: 'result', status: 'success', stats: {} }))).toEqual([]);
  expect(p.end()).toEqual([]);
});
