'use strict';
// agentCliTurn.test.cjs — planAgentCliTurn: unknown CLI, missing binary,
// adapter prompt error, authEnv filtering, native session id lookup.
import { test, expect } from 'vitest';

const { planAgentCliTurn } = require('../agentCliTurn.cjs');
const { AGENT_CLI_CATALOG } = require('../agentCliRegistry.cjs');

const SID = '11111111-2222-4333-8444-555555555555';

function fakeAdapter(over = {}) {
  const calls = [];
  return {
    calls,
    headlessSpawn(o) { calls.push(o); return over.spawn ? over.spawn(o) : { args: ['run', ...(o.nativeSessionId ? ['--session', o.nativeSessionId] : [])], stdin: o.prompt }; },
    createParser() { return { push: () => [], end: () => [] }; },
  };
}

function deps(over = {}) {
  const adapter = over.adapter || fakeAdapter();
  return {
    adapter,
    d: {
      adapterFor: (id) => (id === 'opencode' || id === 'gemini' ? adapter : null),
      resolveAgentCliBin: over.bin === undefined ? () => '/bin/fake' : over.bin,
      readNativeSession: over.read || (() => null),
      createTranscriptWriter: () => ({ userPrompt() {}, event() {}, close() {} }),
      env: over.env || {},
    },
  };
}

test('unknown cli → agent_cli_unknown', () => {
  const { d } = deps();
  const r = planAgentCliTurn({ epic: { agentCli: 'nope' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(r).toMatchObject({ ok: false, code: 'agent_cli_unknown' });
  const r2 = planAgentCliTurn({ epic: { agentCli: 'codex' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(r2).toMatchObject({ ok: false, code: 'agent_cli_unknown' });
});

test('missing binary → agent_cli_missing with label + install (or docs)', () => {
  const { d } = deps({ bin: () => null });
  const r = planAgentCliTurn({ epic: { agentCli: 'opencode' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(r).toEqual({ ok: false, code: 'agent_cli_missing', message: `OpenCode CLI not found on PATH. Install: ${AGENT_CLI_CATALOG.opencode.install}` });
  const r2 = planAgentCliTurn({ epic: { agentCli: 'gemini' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(r2.message).toBe(`Gemini CLI CLI not found on PATH. Install: ${AGENT_CLI_CATALOG.gemini.install}`);
});

test('adapter prompt error → agent_cli_prompt', () => {
  const adapter = fakeAdapter({ spawn: () => ({ error: 'prompt too large' }) });
  const { d } = deps({ adapter });
  const r = planAgentCliTurn({ epic: { agentCli: 'opencode' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(r).toEqual({ ok: false, code: 'agent_cli_prompt', message: 'prompt too large' });
});

test('envExtra copies only catalog authEnv keys that are set', () => {
  const { d } = deps({ env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: '', HOME: '/h', SECRET: 's', GROQ_API_KEY: 'g' } });
  const r = planAgentCliTurn({ epic: { agentCli: 'opencode' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(r.ok).toBe(true);
  expect(r.envExtra).toEqual({ ANTHROPIC_API_KEY: 'a', GROQ_API_KEY: 'g' });
  expect(r.command).toBe('/bin/fake');
  expect(r.cli).toBe('opencode');
  expect(r.stdin).toBe('p');
  expect(typeof r.parser.push).toBe('function');
  expect(typeof r.transcript.userPrompt).toBe('function');
});

test('native id comes from readNativeSession; model only from epic.agentCliModel', () => {
  const adapter = fakeAdapter();
  const seen = [];
  const { d } = deps({ adapter, read: (id) => { seen.push(id); return { cli: 'opencode', nativeSessionId: 'ses_X' }; } });
  const r = planAgentCliTurn({ epic: { agentCli: 'opencode', agentType: 'dev-lead', model: 'opus' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(seen).toEqual([SID]);
  expect(r.args).toEqual(['run', '--session', 'ses_X']);
  expect(adapter.calls[0]).toEqual({ prompt: 'p', nativeSessionId: 'ses_X', model: undefined });
  planAgentCliTurn({ epic: { agentCli: 'opencode', agentCliModel: 'openai/gpt-5' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(adapter.calls[1].model).toBe('openai/gpt-5');
});

test('no stored native id → first turn without one', () => {
  const adapter = fakeAdapter();
  const { d } = deps({ adapter });
  const r = planAgentCliTurn({ epic: { agentCli: 'opencode' }, claudeSessionId: SID, cwd: '/w', prompt: 'p', deps: d });
  expect(adapter.calls[0].nativeSessionId).toBeUndefined();
  expect(r.args).toEqual(['run']);
});
