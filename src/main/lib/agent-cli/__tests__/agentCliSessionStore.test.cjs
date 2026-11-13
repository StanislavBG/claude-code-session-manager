'use strict';
import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ev = require('../agentCliEvents.cjs');
const { classifyLine } = require('../../classifyTranscriptLine.cjs');

const STORE = '../agentCliSessionStore.cjs';
const ID = '123e4567-e89b-42d3-a456-426614174000';
let tmp;
let prevEnv;
let store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-store-'));
  prevEnv = process.env.SM_AGENT_CLI_STATE_DIR;
  process.env.SM_AGENT_CLI_STATE_DIR = tmp;
  store = require(STORE);
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.SM_AGENT_CLI_STATE_DIR;
  else process.env.SM_AGENT_CLI_STATE_DIR = prevEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readLines() {
  const raw = fs.readFileSync(store.transcriptPathFor(ID), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('sidecar round-trip under SM_AGENT_CLI_STATE_DIR', () => {
  expect(store.readNativeSession(ID)).toBeNull();
  store.writeNativeSession(ID, { cli: 'codex', nativeSessionId: 'thread-abc' });
  const file = path.join(tmp, 'sessions', `${ID}.json`);
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.statSync(path.join(tmp, 'sessions')).mode & 0o777).toBe(0o700);
  const got = store.readNativeSession(ID);
  expect(got.cli).toBe('codex');
  expect(got.nativeSessionId).toBe('thread-abc');
  expect(typeof got.updatedAt).toBe('string');
  expect(Number.isNaN(Date.parse(got.updatedAt))).toBe(false);
});

test('with SM_AGENT_CLI_STATE_DIR unset the root is under SM_SCHEDULER_HOME', () => {
  delete process.env.SM_AGENT_CLI_STATE_DIR;
  const prevHome = process.env.SM_SCHEDULER_HOME;
  // A scheduler home distinct from $HOME/.claude/session-manager, so a hand-built
  // os.homedir() root cannot coincide with it.
  const home = path.join(tmp, 'sched-home');
  process.env.SM_SCHEDULER_HOME = home;
  try {
    expect(store.transcriptPathFor(ID)).toBe(path.join(home, 'agent-cli', 'transcripts', `${ID}.jsonl`));
  } finally {
    if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
    else process.env.SM_SCHEDULER_HOME = prevHome;
  }
});

test('transcriptPathFor resolves under <root>/transcripts', () => {
  expect(store.transcriptPathFor(ID)).toBe(path.join(tmp, 'transcripts', `${ID}.jsonl`));
});

test('rejects non-UUID ids everywhere', () => {
  for (const bad of ['../etc/passwd', '', 'abc', null, undefined, 42, `${ID}/..`, `../${ID}`]) {
    expect(() => store.readNativeSession(bad)).toThrow();
    expect(() => store.writeNativeSession(bad, { cli: 'codex', nativeSessionId: 'x' })).toThrow();
    expect(() => store.transcriptPathFor(bad)).toThrow();
    expect(() => store.createTranscriptWriter({ claudeSessionId: bad, cwd: '/x', cli: 'codex' })).toThrow();
  }
});

test('coalesces 3 text deltas into one assistant line flushed at tool_use', () => {
  const w = store.createTranscriptWriter({ claudeSessionId: ID, cwd: '/proj', cli: 'codex' });
  w.event(ev.initEvent('thread-1', 'codex'));
  w.userPrompt('do it');
  w.event(ev.textEvent('Hel'));
  w.event(ev.textEvent('lo '));
  w.event(ev.textEvent('world'));
  w.event(ev.toolUseEvent({ id: 't1', name: 'Bash', input: { command: 'ls' } }));
  w.event(ev.toolResultEvent({ toolUseId: 't1', content: 'a\nb' }));
  w.event(ev.textEvent('done'));
  w.event(ev.resultEvent({ ok: true, text: 'done', usage: { input_tokens: 10, output_tokens: 5 }, nativeSessionId: 'thread-1' }));
  w.close();

  const lines = readLines();
  expect(lines.map((l) => l.type)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant', 'assistant']);
  const [user, text, toolUse, toolResult, text2, usage] = lines;
  expect(user.message).toEqual({ role: 'user', content: 'do it' });
  expect(user.sessionId).toBe(ID);
  expect(user.cwd).toBe('/proj');
  expect(user.agentCli).toBe('codex');
  expect(typeof user.uuid).toBe('string');
  expect(typeof user.timestamp).toBe('string');
  expect(text.message).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] });
  expect(toolUse.message.content[0]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Bash' });
  expect(toolResult.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
  expect(text2.message.content).toEqual([{ type: 'text', text: 'done' }]);
  expect(usage.message).toEqual({ role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 5 } });
  expect(new Set(lines.map((l) => l.uuid)).size).toBe(lines.length);

  const kinds = new Set(['user', 'assistant', 'tool_use', 'tool_result', 'usage']);
  const seen = [];
  for (const line of lines) {
    const events = classifyLine(line);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(kinds.has(e.kind)).toBe(true);
      seen.push(e.kind);
    }
  }
  for (const k of kinds) expect(seen).toContain(k);
});

test('close() flushes pending text; write failures never throw', () => {
  const w = store.createTranscriptWriter({ claudeSessionId: ID, cwd: '/proj', cli: 'opencode' });
  w.event(ev.textEvent('tail'));
  w.close();
  expect(readLines().map((l) => l.message.content[0].text)).toEqual(['tail']);

  // Make the transcript path a directory so appendFileSync fails.
  fs.rmSync(store.transcriptPathFor(ID));
  fs.mkdirSync(store.transcriptPathFor(ID));
  const errs = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a) => errs.push(a);
  console.warn = (...a) => errs.push(a);
  try {
    const w2 = store.createTranscriptWriter({ claudeSessionId: ID, cwd: '/proj', cli: 'opencode' });
    expect(() => {
      w2.userPrompt('x');
      w2.event(ev.textEvent('y'));
      w2.event(ev.toolUseEvent({ id: 't', name: 'Read', input: {} }));
      w2.close();
    }).not.toThrow();
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
  expect(errs.length).toBe(1);
});
