/**
 * prereqs.test.cjs — checkPrereqs with fully injected execFile / platform /
 * credentials / fs existence. No real git or claude is ever spawned.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/prereqs.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { checkPrereqs } = require('../prereqs.cjs');

/** execFile fake: `handlers` maps "cmd arg arg" → stdout string | Error. */
function fakeExec(handlers) {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    for (const [k, v] of Object.entries(handlers)) {
      if (key === k || key.endsWith(k)) {
        if (v instanceof Error) throw v;
        return { stdout: v, stderr: '' };
      }
    }
    throw new Error(`unexpected probe: ${key}`);
  };
}

const okHandlers = {
  'git --version': 'git version 2.45.1\n',
  'xcode-select -p': '/Library/Developer/CommandLineTools\n',
  '/bin/claude --version': '2.1.0 (Claude Code)\n',
};
const base = (over = {}) => ({
  platform: 'linux',
  claudeBin: '/bin/claude',
  hasCredentials: async () => true,
  exists: () => true,
  execFile: fakeExec(okHandlers),
  ...over,
});
const byId = (items, id) => items.find((i) => i.id === id);

test('all ok on linux: three items, no fixes', async () => {
  const items = await checkPrereqs(base());
  expect(items.map((i) => i.id)).toEqual(['git', 'claude-cli', 'claude-auth']);
  for (const i of items) {
    expect(i.ok).toBe(true);
    expect(i.fix).toBeNull();
  }
  expect(byId(items, 'git').version).toBe('2.45.1');
  expect(byId(items, 'claude-cli').version).toBe('2.1.0 (Claude Code)');
});

test('git missing on linux points at git-scm downloads', async () => {
  const items = await checkPrereqs(base({
    execFile: fakeExec({ ...okHandlers, 'git --version': new Error('ENOENT') }),
  }));
  const git = byId(items, 'git');
  expect(git.ok).toBe(false);
  expect(git.version).toBeNull();
  expect(git.detail).toContain('ENOENT');
  expect(git.fix.url).toBe('https://git-scm.com/downloads');
  expect(git.fix.shell).toBe('sh');
});

test('git on darwin requires xcode-select -p to succeed', async () => {
  const bad = await checkPrereqs(base({
    platform: 'darwin',
    execFile: fakeExec({ ...okHandlers, 'xcode-select -p': new Error('exit 2') }),
  }));
  const git = byId(bad, 'git');
  expect(git.ok).toBe(false);
  expect(git.fix).toMatchObject({ command: 'xcode-select --install', shell: 'sh' });
  const good = await checkPrereqs(base({ platform: 'darwin' }));
  expect(byId(good, 'git').ok).toBe(true);
});

test('claude-cli missing: install one-liner per platform', async () => {
  const exec = fakeExec({ ...okHandlers, '/bin/claude --version': new Error('ENOENT') });
  const unix = byId(await checkPrereqs(base({ execFile: exec })), 'claude-cli');
  expect(unix.ok).toBe(false);
  expect(unix.fix).toEqual({
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    shell: 'sh',
    url: 'https://docs.claude.com/en/docs/claude-code/setup',
  });
  const win = byId(await checkPrereqs(base({ platform: 'win32', execFile: exec })), 'claude-cli');
  expect(win.fix.command).toBe('irm https://claude.ai/install.ps1 | iex');
  expect(win.fix.shell).toBe('powershell');
});

test('claude-auth missing: fix is `claude` with sign-in detail', async () => {
  const items = await checkPrereqs(base({ hasCredentials: async () => false }));
  const auth = byId(items, 'claude-auth');
  expect(auth.ok).toBe(false);
  expect(auth.fix.command).toBe('claude');
  expect(auth.fix.shell).toBe('sh');
  expect(auth.detail).toMatch(/sign in/i);
});

test('probe timeout is treated as not-ok and never throws', async () => {
  const timeout = Object.assign(new Error('Command timed out'), { killed: true, code: null });
  const items = await checkPrereqs(base({
    execFile: fakeExec({ ...okHandlers, 'git --version': timeout, '/bin/claude --version': timeout }),
  }));
  expect(byId(items, 'git').ok).toBe(false);
  expect(byId(items, 'claude-cli').ok).toBe(false);
  expect(byId(items, 'claude-auth').ok).toBe(true);
});

test('hasCredentials throwing is not-ok, not a throw', async () => {
  const items = await checkPrereqs(base({ hasCredentials: async () => { throw new Error('boom'); } }));
  expect(byId(items, 'claude-auth').ok).toBe(false);
});

test('win32 adds git-bash and uses winget for git', async () => {
  const items = await checkPrereqs(base({ platform: 'win32', exists: () => false, hasCredentials: async () => false,
    execFile: fakeExec({ ...okHandlers, 'git --version': new Error('ENOENT') }) }));
  expect(items.map((i) => i.id)).toEqual(['git', 'git-bash', 'claude-cli', 'claude-auth']);
  const winget = 'winget install --id Git.Git -e --source winget';
  expect(byId(items, 'git').fix).toMatchObject({ command: winget, shell: 'powershell' });
  const bash = byId(items, 'git-bash');
  expect(bash.ok).toBe(false);
  expect(bash.fix.command).toBe(winget);
  expect(byId(items, 'claude-auth').fix.shell).toBe('powershell');
});

test('win32 git-bash ok when bash.exe exists', async () => {
  const items = await checkPrereqs(base({ platform: 'win32', exists: () => true }));
  expect(byId(items, 'git-bash').ok).toBe(true);
  expect(byId(items, 'git-bash').fix).toBeNull();
});

test('git-bash is absent off win32', async () => {
  for (const platform of ['linux', 'darwin']) {
    expect(byId(await checkPrereqs(base({ platform })), 'git-bash')).toBeUndefined();
  }
});
