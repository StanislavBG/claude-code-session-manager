'use strict';
import { test, expect } from 'vitest';
const { registerAgentCliHandlers, buildTerminalCommand, shellQuote } = require('../agentCliIpc.cjs');
const codex = require('../adapters/codex.cjs');
const opencode = require('../adapters/opencode.cjs');

const CWD = '/proj';
const SID_CODEX = '11111111-1111-4111-8111-111111111111';
const SID_OPEN = '22222222-2222-4222-8222-222222222222';
const SID_CLAUDE = '33333333-3333-4333-8333-333333333333';
const SID_NOBIN = '44444444-4444-4444-8444-444444444444';

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
      },
    }),
    resolveAgentCliBin: (id) => (id === 'opencode' ? '/usr/bin/opencode' : id === 'codex' ? "/opt/it's/codex" : null),
    readNativeSession: (sid) => (sid === SID_CODEX ? { cli: 'codex', nativeSessionId: 'thread-abc' } : null),
    adapterFor: (id) => ({ codex, opencode }[id] || null),
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
  expect(r.command.startsWith("'/opt/it'\\''s/codex' 'resume' 'thread-abc'")).toBe(true);
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
