'use strict';
import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const agy = require('../adapters/antigravity.cjs');
const ev = require('../agentCliEvents.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'antigravity-stream.jsonl');
const CID = 'conv-7a1b2c3d';
const FLAGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions'];
const line = (o) => JSON.stringify(o);

function run(lines) {
  const p = agy.createParser();
  const out = [];
  for (const l of lines) out.push(...p.push(l));
  out.push(...p.end({ exitCode: 0 }));
  return { p, out };
}

test('exports the adapter shape', () => {
  expect(agy.id).toBe('antigravity');
  for (const k of ['headlessSpawn', 'createParser', 'interactiveArgs']) expect(typeof agy[k]).toBe('function');
});

test('headlessSpawn: argv flags, prompt delivered as one stdin stream-json line', () => {
  const prompt = 'do it --conversation x\n"quoted"';
  const r = agy.headlessSpawn({ prompt, nativeSessionId: null });
  expect(r.args).toEqual(FLAGS);
  expect(r.stdin).toBe(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
  expect(JSON.parse(r.stdin.trim())).toEqual({ event: 'user', message: { content: prompt } });
  expect(r.stdin.endsWith('\n')).toBe(true);
  expect(r.stdin.slice(0, -1)).not.toContain('\n');
  const m = agy.headlessSpawn({ prompt, nativeSessionId: CID, model: 'gemini-3-pro' });
  expect(m.args).toEqual([...FLAGS, '--conversation', CID, '--model', 'gemini-3-pro']);
  expect(m.args).not.toContain(prompt);
  expect(agy.headlessSpawn({ prompt, model: 'm' }).args).toEqual([...FLAGS, '--model', 'm']);
});

test('interactiveArgs fresh and resume', () => {
  expect(agy.interactiveArgs({})).toEqual(['--dangerously-skip-permissions']);
  expect(agy.interactiveArgs({ model: 'm1' })).toEqual(['--dangerously-skip-permissions', '--model', 'm1']);
  expect(agy.interactiveArgs({ nativeSessionId: CID, model: 'm1' }))
    .toEqual(['--dangerously-skip-permissions', '--conversation', CID, '--model', 'm1']);
});

test('fixture run translates to Claude stream-json events', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  const { p, out } = run(lines);
  expect(p.nativeSessionId()).toBe(CID);
  expect(out).toEqual([
    ev.initEvent(CID, 'antigravity'),
    ev.textEvent('Hello'),
    ev.textEvent(', listing files.'),
    ev.toolUseEvent({ id: `${CID}:2`, name: 'run_command', input: { command: 'ls' } }),
    ev.toolResultEvent({ toolUseId: `${CID}:2`, content: '', isError: false }),
    ev.resultEvent({
      ok: true,
      text: 'Hello, listing files.',
      usage: { input_tokens: 900, output_tokens: 42 },
      nativeSessionId: CID,
    }),
  ]);
  expect(out.filter((e) => e.type === 'result')).toHaveLength(1);
  expect(out.at(-1).usage).toEqual({ input_tokens: 900, output_tokens: 42 });
});

test('error result: text falls back to response then error; non-numeric usage dropped', () => {
  const { out } = run([
    line({ event: 'init', init: { conversation_id: CID, cwd: '/x' } }),
    line({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file' } }),
    line({ event: 'result', result: { conversation_id: CID, status: 'ERROR', response: '', error: 'quota exceeded', usage: { input_tokens: '5', output_tokens: 3 } } }),
  ]);
  expect(out).toEqual([
    ev.initEvent(CID, 'antigravity'),
    ev.toolUseEvent({ id: `${CID}:1`, name: 'view_file', input: {} }),
    ev.resultEvent({ ok: false, text: 'quota exceeded', usage: { output_tokens: 3 }, nativeSessionId: CID }),
  ]);
  const r2 = run([line({ event: 'result', result: { conversation_id: CID, status: 'CANCELED', response: 'partial' } })]);
  expect(r2.out).toEqual([ev.resultEvent({ ok: false, text: 'partial', nativeSessionId: CID })]);
});

test('end() returns [] with or without result; malformed/unknown lines ignored; push never throws', () => {
  const q = agy.createParser();
  q.push(line({ event: 'init', conversation_id: CID }));
  expect(q.end()).toEqual([]);
  const p = agy.createParser();
  for (const bad of ['not json', '{bad', '[]', '', null, undefined, 42, line({ event: 'mystery' }), line({ type: 'init', session_id: 'x' }),
    line({ event: 'step_update' }), line({ event: 'step_update', step_update: null }),
    line({ event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'echo' } }),
    line({ event: 'step_update', step_update: { step_type: 'checkpoint', state: 'DONE' } }),
    line({ event: 'result', result: 'nope' })]) {
    expect(() => p.push(bad)).not.toThrow();
    expect(p.push(bad)).toEqual([]);
  }
  expect(p.push(line({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))).toHaveLength(1);
  expect(p.push(line({ event: 'result', result: { status: 'SUCCESS' } }))).toEqual([]);
  expect(p.end()).toEqual([]);
});
