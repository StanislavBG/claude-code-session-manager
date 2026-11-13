'use strict';
import { test, expect, beforeEach, afterEach } from 'vitest';
const reg = require('../agentCliRegistry.cjs');

const NON_CLAUDE = ['codex', 'gemini', 'antigravity', 'cursor', 'opencode'];
const ENV_KEYS = NON_CLAUDE.map((id) => 'SM_AGENT_CLI_BIN_' + id.toUpperCase());
let saved;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  reg._resetCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function deps(over = {}) {
  return {
    findCommand: () => null,
    realpathSync: (p) => p,
    execFile: async () => ({ stdout: '' }),
    now: () => 0,
    ...over,
  };
}

test('catalog has the five CLIs with the specified fields', () => {
  const c = reg.AGENT_CLI_CATALOG;
  expect(Object.keys(c)).toEqual(NON_CLAUDE);
  expect(c.codex).toMatchObject({ label: 'Codex', bins: ['codex'], install: 'npm install -g @openai/codex', login: 'codex login', authEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
  expect(c.gemini).toMatchObject({ label: 'Gemini CLI', bins: ['gemini'], install: 'npm install -g @google/gemini-cli', authEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] });
  expect(c.antigravity).toMatchObject({ label: 'Antigravity CLI', bins: ['agy'], install: null, docs: 'https://antigravity.google/docs/cli/' });
  expect(c.cursor).toMatchObject({ label: 'Cursor Agent', bins: ['cursor-agent', 'agent'], install: 'curl https://cursor.com/install -fsS | bash', login: 'cursor-agent login', authEnv: ['CURSOR_API_KEY'] });
  expect(c.opencode).toMatchObject({ label: 'OpenCode', bins: ['opencode'], install: 'npm install -g opencode-ai', login: 'opencode auth login' });
  expect(c.opencode.authEnv).toContain('OPENROUTER_API_KEY');
  expect(c.opencode.authEnv).toHaveLength(9);
  for (const id of NON_CLAUDE) expect(c[id].docs).toMatch(/^https:\/\//);
});

test('env override wins over PATH lookup', () => {
  process.env.SM_AGENT_CLI_BIN_CODEX = '/stub/codex';
  let called = false;
  const r = reg.resolveAgentCliBin('codex', deps({ findCommand: () => { called = true; return '/usr/bin/codex'; } }));
  expect(r).toBe('/stub/codex');
  expect(called).toBe(false);
});

test('resolves the first found bin', () => {
  expect(reg.resolveAgentCliBin('gemini', deps({ findCommand: (n) => (n === 'gemini' ? '/u/gemini' : null) }))).toBe('/u/gemini');
  expect(reg.resolveAgentCliBin('cursor', deps({ findCommand: (n) => '/u/' + n }))).toBe('/u/cursor-agent');
});

test('cursor accepts bare `agent` only when its realpath contains cursor', () => {
  const find = (n) => (n === 'agent' ? '/u/agent' : null);
  expect(reg.resolveAgentCliBin('cursor', deps({ findCommand: find, realpathSync: () => '/home/x/.local/share/cursor-agent/versions/1/cursor-agent' }))).toBe('/u/agent');
  expect(reg.resolveAgentCliBin('cursor', deps({ findCommand: find, realpathSync: () => '/opt/other/agent' }))).toBe(null);
  expect(reg.resolveAgentCliBin('cursor', deps({ findCommand: find, realpathSync: () => { throw new Error('ENOENT'); } }))).toBe(null);
});

test('missing binaries, unknown ids and claude resolve to null', () => {
  for (const id of NON_CLAUDE) expect(reg.resolveAgentCliBin(id, deps())).toBe(null);
  const find = () => '/u/x';
  expect(reg.resolveAgentCliBin('claude', deps({ findCommand: find }))).toBe(null);
  expect(reg.resolveAgentCliBin('nope', deps({ findCommand: find }))).toBe(null);
  expect(reg.resolveAgentCliBin(undefined, deps({ findCommand: find }))).toBe(null);
  expect(reg.resolveAgentCliBin('__proto__', deps({ findCommand: find }))).toBe(null);
});

test('detectAgentClis returns one row per non-claude id with version from --version', async () => {
  const calls = [];
  const rows = await reg.detectAgentClis({}, deps({
    findCommand: (n) => (n === 'codex' ? '/u/codex' : null),
    execFile: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: 'codex-cli 1.2.3\nextra line\n' }; },
  }));
  expect(rows.map((r) => r.id)).toEqual(NON_CLAUDE);
  expect(rows[0]).toEqual({ id: 'codex', label: 'Codex', installed: true, path: '/u/codex', version: 'codex-cli 1.2.3', install: 'npm install -g @openai/codex', docs: reg.AGENT_CLI_CATALOG.codex.docs, login: 'codex login' });
  expect(rows[1]).toMatchObject({ id: 'gemini', installed: false, path: null, version: null });
  expect(calls).toHaveLength(1);
  expect(calls[0].cmd).toBe('/u/codex');
  expect(calls[0].args).toEqual(['--version']);
  expect(calls[0].opts.timeout).toBe(5000);
  expect(calls[0].opts.shell).toBeFalsy();
  expect(typeof calls[0].opts.env.PATH).toBe('string');
});

test('version is trimmed to 120 chars', async () => {
  const rows = await reg.detectAgentClis({}, deps({ findCommand: (n) => (n === 'gemini' ? '/u/gemini' : null), execFile: async () => ({ stdout: 'v'.repeat(300) }) }));
  expect(rows[1].version).toHaveLength(120);
});

test('probe timeout/failure gives installed:true, version:null and never rejects', async () => {
  const rows = await reg.detectAgentClis({}, deps({
    findCommand: (n) => '/u/' + n,
    execFile: async () => { const e = new Error('timed out'); e.killed = true; e.signal = 'SIGTERM'; throw e; },
  }));
  for (const r of rows) expect(r).toMatchObject({ installed: true, version: null });
  const rows2 = await reg.detectAgentClis({ refresh: true }, deps({ findCommand: () => { throw new Error('boom'); } }));
  expect(rows2).toHaveLength(5);
  for (const r of rows2) expect(r.installed).toBe(false);
});

test('results are cached for 60 s unless refresh is true', async () => {
  let t = 1000;
  let finds = 0;
  const d = deps({ now: () => t, findCommand: () => { finds++; return null; } });
  await reg.detectAgentClis({}, d);
  const after1 = finds;
  expect(after1).toBeGreaterThan(0);
  t += 59_000;
  await reg.detectAgentClis({}, d);
  expect(finds).toBe(after1);
  await reg.detectAgentClis({ refresh: true }, d);
  expect(finds).toBe(after1 * 2);
  t += 61_000;
  await reg.detectAgentClis(undefined, d);
  expect(finds).toBe(after1 * 3);
});

test('adapterFor returns null for unknown ids', () => {
  for (const x of ['claude', 'nope', '../x', '__proto__', undefined, null, 1]) expect(reg.adapterFor(x)).toBe(null);
});
