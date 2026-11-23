'use strict';
import { test, expect } from 'vitest';
const { registerAgentCliHandlers, buildTerminalCommand, shellQuote } = require('../agentCliIpc.cjs');
const codex = require('../adapters/codex.cjs');
const opencode = require('../adapters/opencode.cjs');
const gemini = require('../adapters/gemini.cjs');

const CWD = '/proj';
const SID_CODEX = '11111111-1111-4111-8111-111111111111';
const SID_OPEN = '22222222-2222-4222-8222-222222222222';
const SID_CLAUDE = '33333333-3333-4333-8333-333333333333';
const SID_NOBIN = '44444444-4444-4444-8444-444444444444';
const SID_GEMINI = '55555555-5555-4555-8555-555555555555';
const GEMINI_DEFAULTS = "/state/it's/gemini-system-defaults.json";

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}

function deps(over = {}) {
  return {
    readActiveIndex: (cwd) => ({
      sessions: cwd !== CWD ? {} : {
        a: { claudeSessionId: SID_CODEX, agentCli: 'codex', agentCliModel: 'gpt-5' },
        b: { claudeSessionId: SID_OPEN, agentCli: 'opencode' },
        c: { claudeSessionId: SID_CLAUDE, agentCli: 'claude' },
        d: { claudeSessionId: SID_NOBIN, agentCli: 'codex' },
        e: { claudeSessionId: SID_GEMINI, agentCli: 'gemini' },
      },
    }),
    resolveAgentCliBin: (id) => ({ opencode: '/usr/bin/opencode', codex: "/opt/it's/codex", gemini: '/usr/bin/gemini' }[id] || null),
    readNativeSession: (sid) => (sid === SID_CODEX ? { cli: 'codex', nativeSessionId: 'thread-abc' } : null),
    adapterFor: (id) => ({ codex, opencode, gemini }[id] || null),
    ensureGeminiSystemDefaults: () => ({ path: GEMINI_DEFAULTS }),
    platform: 'linux',
    detectAgentClis: async (opts) => [{ id: 'codex', installed: true, refresh: !!(opts && opts.refresh) }],
    ...over,
  };
}

function setup(over) {
  const ipc = fakeIpc();
  registerAgentCliHandlers({ ipcMain: ipc, deps: deps(over) });
  return {
    detect: (p) => ipc.handlers.get('agentCli:detect')({}, p),
    cmd: (p) => ipc.handlers.get('agentCli:terminal-command')({}, p),
  };
}

test('shellQuote matches presets.ts rule', () => {
  expect(shellQuote("a'b")).toBe("'a'\\''b'");
});

test('codex Epic with a stored native id yields a quoted resume line', async () => {
  const { cmd } = setup();
  const r = await cmd({ cwd: CWD, claudeSessionId: SID_CODEX });
  const expected = ["/opt/it's/codex", ...codex.interactiveArgs({ nativeSessionId: 'thread-abc', claudeSessionId: SID_CODEX, model: 'gpt-5' })]
    .map(shellQuote).join(' ');
  expect(r).toEqual({ ok: true, command: expected });
  expect(r.command.startsWith(`'/opt/it'\\''s/codex' '-c' 'project_doc_fallback_filenames=["CLAUDE.md"]' 'resume' 'thread-abc'`)).toBe(true);
  expect(r.command).toContain("'gpt-5'");
  expect(r.command).not.toMatch(/[\r\n]$/);
});

test('fresh opencode Epic yields --auto with no --session', async () => {
  const { cmd } = setup();
  const r = await cmd({ cwd: CWD, claudeSessionId: SID_OPEN });
  expect(r.ok).toBe(true);
  expect(r.command).toBe("'/usr/bin/opencode' '--auto'");
  expect(r.command).not.toContain('--session');
});

test('Claude Epic is refused', async () => {
  const { cmd } = setup();
  const r = await cmd({ cwd: CWD, claudeSessionId: SID_CLAUDE });
  expect(r.ok).toBe(false);
  expect(r.message).toMatch(/not a non-Claude/i);
});

test('unknown Epic is refused', async () => {
  const { cmd } = setup();
  const r = await cmd({ cwd: '/other', claudeSessionId: SID_CODEX });
  expect(r.ok).toBe(false);
});

test('missing binary returns the install message', async () => {
  const { cmd } = setup({ resolveAgentCliBin: () => null });
  const r = await cmd({ cwd: CWD, claudeSessionId: SID_NOBIN });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('npm install -g @openai/codex');
});

test('detect passes refresh through', async () => {
  const { detect } = setup();
  expect(await detect({ refresh: true })).toEqual([{ id: 'codex', installed: true, refresh: true }]);
  expect(await detect({})).toEqual([{ id: 'codex', installed: true, refresh: false }]);
});

test('bad payloads are rejected', () => {
  const { detect, cmd } = setup();
  expect(() => detect({ refresh: 'yes' })).toThrow();
  expect(() => detect({ extra: 1 })).toThrow();
  expect(() => cmd({ cwd: CWD })).toThrow();
  expect(() => cmd({ cwd: CWD, claudeSessionId: SID_CODEX, extra: 1 })).toThrow();
  expect(() => cmd({ cwd: 'x'.repeat(4097), claudeSessionId: SID_CODEX })).toThrow();
  expect(() => cmd({ cwd: CWD, claudeSessionId: 'x'.repeat(201) })).toThrow();
  expect(() => cmd(null)).toThrow();
});

test('buildTerminalCommand is exported and never throws on a broken store', async () => {
  const r = await buildTerminalCommand({ cwd: CWD, claudeSessionId: SID_CODEX }, deps({ readNativeSession: () => { throw new Error('boom'); } }));
  expect(r.ok).toBe(true);
  expect(r.command).not.toContain('resume');
});

function geminiBase() {
  return ['/usr/bin/gemini', ...gemini.interactiveArgs({ nativeSessionId: null, claudeSessionId: SID_GEMINI, model: undefined })]
    .map(shellQuote).join(' ');
}

test.each(['linux', 'darwin'])('gemini Epic on %s is prefixed with the quoted system-defaults path', async (platform) => {
  let calls = 0;
  const r = await buildTerminalCommand({ cwd: CWD, claudeSessionId: SID_GEMINI },
    deps({ platform, ensureGeminiSystemDefaults: () => { calls++; return { path: GEMINI_DEFAULTS }; } }));
  expect(r).toEqual({ ok: true, command: `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=${shellQuote(GEMINI_DEFAULTS)} ${geminiBase()}` });
  expect(r.command.startsWith("GEMINI_CLI_SYSTEM_DEFAULTS_PATH='/state/it'\\''s/gemini-system-defaults.json' '/usr/bin/gemini'")).toBe(true);
  expect(calls).toBe(1);
});

test('gemini Epic on win32 has no prefix and never writes the defaults file', async () => {
  let calls = 0;
  const r = await buildTerminalCommand({ cwd: CWD, claudeSessionId: SID_GEMINI },
    deps({ platform: 'win32', ensureGeminiSystemDefaults: () => { calls++; return { path: GEMINI_DEFAULTS }; } }));
  expect(r).toEqual({ ok: true, command: geminiBase() });
  expect(calls).toBe(0);
});

test('gemini Epic falls back to the plain command when defaults are null or throw', async () => {
  const nul = await buildTerminalCommand({ cwd: CWD, claudeSessionId: SID_GEMINI }, deps({ ensureGeminiSystemDefaults: () => null }));
  expect(nul).toEqual({ ok: true, command: geminiBase() });
  const thrown = await buildTerminalCommand({ cwd: CWD, claudeSessionId: SID_GEMINI },
    deps({ ensureGeminiSystemDefaults: () => { throw new Error('EACCES'); } }));
  expect(thrown).toEqual({ ok: true, command: geminiBase() });
});

test('codex command carries no gemini prefix and never asks for gemini defaults', async () => {
  let calls = 0;
  const r = await buildTerminalCommand({ cwd: CWD, claudeSessionId: SID_CODEX },
    deps({ ensureGeminiSystemDefaults: () => { calls++; return { path: GEMINI_DEFAULTS }; } }));
  const expected = ["/opt/it's/codex", ...codex.interactiveArgs({ nativeSessionId: 'thread-abc', claudeSessionId: SID_CODEX, model: 'gpt-5' })]
    .map(shellQuote).join(' ');
  expect(r).toEqual({ ok: true, command: expected });
  expect(r.command).not.toContain('GEMINI_CLI_SYSTEM_DEFAULTS_PATH');
  expect(calls).toBe(0);
});
