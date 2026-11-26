/**
 * peerChatSession.test.cjs — resolvePeerChatSession.
 * Run: timeout 120 npx vitest run src/main/lib/process/__tests__/peerChatSession.test.cjs
 */

'use strict';

import { test, expect, describe, it } from 'vitest';
const http = require('http');
const { spawn } = require('child_process');
const { resolvePeerChatSession } = require('../peerChatSession.cjs');

// client local port 0x1F90=8080 -> server port 0x0050=80 (inode 555)
const NET_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:1F90 0100007F:0050 01 00000000:00000000 00:00000000 00000000  1000        0 555 1 0 0',
].join('\n');

function fakeFs({ environ = 'A=b\0SM_CHAT_SESSION_ID=chat-abcdef12\0SM_PROJECT_ROOT=/proj\0', inode = '555' } = {}) {
  return {
    readFileSync: (p) => {
      if (p === '/proc/net/tcp') return NET_TCP.replace('555', inode);
      if (p === '/proc/net/tcp6') throw new Error('ENOENT');
      if (p === '/proc/42/environ') return environ;
      if (p === '/proc/42/stat') return '42 (node) S 1 0 0';
      throw new Error('ENOENT ' + p);
    },
    readdirSync: (p) => (p === '/proc' ? ['1', '42', 'self'] : p === '/proc/42/fd' ? ['0', '3'] : (() => { throw new Error('EACCES'); })()),
    readlinkSync: (p) => (p === '/proc/42/fd/3' ? 'socket:[555]' : 'pipe:[1]'),
    statSync: () => ({ uid: 1000 }),
  };
}
const sock = { remotePort: 8080, localPort: 80 };
const base = { platform: 'linux', getuid: () => 1000 };

describe('injected deps', () => {
  it('match', async () => {
    expect(await resolvePeerChatSession(sock, { ...base, fs: fakeFs() }))
      .toEqual({ chatSessionId: 'chat-abcdef12', projectRoot: '/proj' });
  });
  it('no match', async () => {
    expect(await resolvePeerChatSession(sock, { ...base, fs: fakeFs({ inode: '999' }) })).toBeNull();
    expect(await resolvePeerChatSession({ remotePort: 1, localPort: 2 }, { ...base, fs: fakeFs() })).toBeNull();
  });
  it('bad id', async () => {
    expect(await resolvePeerChatSession(sock, { ...base, fs: fakeFs({ environ: 'SM_CHAT_SESSION_ID=a/b\0' }) })).toBeNull();
  });
  it('throwing deps -> null', async () => {
    const boom = () => { throw new Error('boom'); };
    const fs = { readFileSync: boom, readdirSync: boom, readlinkSync: boom, statSync: boom };
    expect(await resolvePeerChatSession(sock, { ...base, fs })).toBeNull();
    expect(await resolvePeerChatSession(sock, { platform: 'darwin', execFile: boom })).toBeNull();
    expect(await resolvePeerChatSession(null)).toBeNull();
    expect(await resolvePeerChatSession(sock, { platform: 'win32' })).toBeNull();
  });
  it('darwin via lsof/ps', async () => {
    const execFile = (file, args, opts, cb) => {
      if (file === 'lsof') return cb(null, `p${process.pid}\np777\n`);
      if (args.includes('command=')) return cb(null, 'node x SM_CHAT_SESSION_ID=chat-abcdef12 SM_PROJECT_ROOT=/p');
      return cb(new Error('no'));
    };
    expect(await resolvePeerChatSession(sock, { platform: 'darwin', execFile }))
      .toEqual({ chatSessionId: 'chat-abcdef12', projectRoot: '/p' });
  });
});

describe('real socket', () => {
  it.skipIf(process.platform !== 'linux')('resolves a child process by its env', async () => {
    let resolveSock;
    const got = new Promise((r) => { resolveSock = r; });
    const server = http.createServer((req, res) => {
      resolveSock(req.socket);
      setTimeout(() => res.end('ok'), 1500);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const child = spawn(process.execPath, ['-e',
      `require('http').get({host:'127.0.0.1',port:${port}},r=>r.resume()).on('error',()=>{})`],
    { env: { ...process.env, SM_CHAT_SESSION_ID: 'test-chat-1234', SM_PROJECT_ROOT: '/tmp/x' }, stdio: 'ignore' });
    try {
      const socket = await got;
      expect(await resolvePeerChatSession(socket)).toEqual({ chatSessionId: 'test-chat-1234', projectRoot: '/tmp/x' });
    } finally {
      child.kill();
      server.closeAllConnections?.();
      server.close();
    }
  });
});
