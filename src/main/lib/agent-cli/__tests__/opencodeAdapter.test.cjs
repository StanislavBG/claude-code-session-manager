'use strict';
import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const opencode = require('../adapters/opencode.cjs');
const ev = require('../agentCliEvents.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'opencode-run.jsonl');
const SID = 'ses_e2c3efb91ffeZqm9hUYGt0mu07';
const FLAGS = ['run', '--format', 'json', '--auto'];
const line = (o) => JSON.stringify(o);

function run(lines, exitCode = 0) {
  const p = opencode.createParser();
  const out = [];
  for (const l of lines) out.push(...p.push(l));
  const tail = p.end({ exitCode });
  return { p, out, tail };
}

test('exports the adapter shape', () => {
  expect(opencode.id).toBe('opencode');
  for (const k of ['headlessSpawn', 'createParser', 'interactiveArgs']) expect(typeof opencode[k]).toBe('function');
});

test('headlessSpawn: prompt goes over stdin, never into argv', () => {
  const prompt = 'write hello.txt --model nope';
  expect(opencode.headlessSpawn({ prompt })).toEqual({ args: FLAGS, stdin: prompt });
  const full = opencode.headlessSpawn({ prompt, nativeSessionId: SID, model: 'opencode/big-pickle' });
  expect(full).toEqual({ args: [...FLAGS, '--session', SID, '--model', 'opencode/big-pickle'], stdin: prompt });
  expect(full.args).not.toContain(prompt);
  expect(opencode.headlessSpawn({ prompt, model: 'm' }).args).toEqual([...FLAGS, '--model', 'm']);
});

test('interactiveArgs', () => {
  expect(opencode.interactiveArgs()).toEqual(['--auto']);
  expect(opencode.interactiveArgs({ nativeSessionId: SID, model: 'm' })).toEqual(['--auto', '--session', SID, '--model', 'm']);
});

test('replays the captured opencode run', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  const { p, out, tail } = run(lines, 0);
  expect(p.nativeSessionId()).toBe(SID);
  expect(out[0]).toEqual(ev.initEvent(SID, 'opencode'));
  expect(out.filter((e) => e.type === 'system')).toHaveLength(1);
  expect(out).toContainEqual(ev.toolUseEvent({
    id: 'call_a65c01e091004246a362eae4',
    name: 'write',
    input: { filePath: '/tmp/oc-probe/work/hello.txt', content: 'hi' },
  }));
  const useIdx = out.findIndex((e) => e.message?.content?.[0]?.type === 'tool_use');
  expect(out[useIdx + 1]).toEqual(ev.toolResultEvent({
    toolUseId: 'call_a65c01e091004246a362eae4', content: 'Wrote file successfully.', isError: false,
  }));
  expect(out).toContainEqual(ev.textEvent('OK'));
  expect(out.some((e) => e.type === 'result')).toBe(false);
  expect(tail).toEqual([ev.resultEvent({
    ok: true,
    text: 'OK',
    nativeSessionId: SID,
    usage: { input_tokens: 263, output_tokens: 71, cache_read_input_tokens: 22272 },
  })]);
});

test('no result when exit code is nonzero or the run never stopped', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  expect(run(lines, 1).tail).toEqual([]);
  expect(run(lines.slice(0, 4), 0).tail).toEqual([]);
});

test('error run: end emits an error result with the recorded message', () => {
  const errLines = [
    line({ type: 'step_start', sessionID: 'ses_err', part: { type: 'step-start' } }),
    line({ type: 'error', sessionID: 'ses_err', error: { name: 'APIError', data: { message: 'rate limited', statusCode: 429, isRetryable: true } } }),
  ];
  const { out, tail } = run(errLines, 1);
  expect(out).toEqual([ev.initEvent('ses_err', 'opencode')]);
  expect(tail).toHaveLength(1);
  expect(tail[0]).toMatchObject({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited', session_id: 'ses_err' });

  const top = run([line({ type: 'error', message: 'top level', error: { name: 'X', data: { message: 'inner' } } })], 0);
  expect(top.tail[0]).toMatchObject({ subtype: 'error', result: 'top level' });
  const named = run([line({ type: 'error', error: { name: 'ProviderAuthError' } })], 0);
  expect(named.tail[0]).toMatchObject({ subtype: 'error', result: 'ProviderAuthError' });
});

test('tool error status maps to is_error and missing output to empty string', () => {
  const { out } = run([line({
    type: 'tool_use', sessionID: SID,
    part: { tool: 'bash', callID: 'c1', state: { status: 'error', input: { command: 'false' } } },
  })]);
  expect(out[1]).toEqual(ev.toolUseEvent({ id: 'c1', name: 'bash', input: { command: 'false' } }));
  expect(out[2]).toEqual(ev.toolResultEvent({ toolUseId: 'c1', content: '', isError: true }));
});

test('push ignores malformed and unknown lines and never throws', () => {
  const p = opencode.createParser();
  for (const l of ['', 'not json', '[1,2]', '{"type":', line({ type: 'mystery' }), line({ type: 'text' }),
    line({ type: 'tool_use', part: null }), line({ type: 'step_finish', part: { tokens: 'x' } }), undefined, null, 42]) {
    expect(() => p.push(l)).not.toThrow();
    expect(p.push(l)).toEqual([]);
  }
  expect(p.end({ exitCode: 0 })).toEqual([]);
});
