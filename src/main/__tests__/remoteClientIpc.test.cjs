'use strict';

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
const Module = require('node:module');

const handlers = new Map();
const sends = [];
const client = {
  listPeers: vi.fn(() => []),
  getStatus: vi.fn(() => ({ status: 'idle', reason: null, sas: null })),
  connect: vi.fn(async () => ({ status: 'connecting', reason: null, sas: null })),
  confirmSas: vi.fn(() => ({ ok: true })),
  removePeer: vi.fn(),
  send: vi.fn(async () => ({ ok: true })),
  onEvent: vi.fn(() => () => {}),
};

function stub(rel, exports) {
  const p = require.resolve(rel);
  const m = new Module(p);
  m.filename = p; m.loaded = true; m.exports = exports;
  require.cache[p] = m;
}
stub('../remoteClient.cjs', { remoteClient: client });
stub('../lib/sendToRenderer.cjs', { sendIfAlive: (_w, channel, payload) => sends.push({ channel, payload }) });
const electronPath = require.resolve('electron');
const em = new Module(electronPath);
em.filename = electronPath; em.loaded = true;
em.exports = { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } };
require.cache[electronPath] = em;

const { registerRemoteClientHandlers } = require('../remoteClientIpc.cjs');
const { ALLOWED_COMMANDS } = require('../ipcSchemas.cjs');
const call = (ch, payload) => handlers.get(ch)({}, payload);

let dispose;
beforeEach(() => {
  vi.clearAllMocks();
  sends.length = 0;
  handlers.clear();
  dispose?.();
  dispose = registerRemoteClientHandlers(() => ({}));
});
afterAll(() => dispose?.());

describe('remoteClientIpc', () => {
  it('registers all five channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'remoteClient:confirm-sas', 'remoteClient:connect', 'remoteClient:list',
      'remoteClient:remove', 'remoteClient:send',
    ]);
  });

  it('rejects malformed payloads before reaching remoteClient', () => {
    expect(() => call('remoteClient:connect', { peerId: '' })).toThrow();
    expect(() => call('remoteClient:remove', { peerId: 'x'.repeat(129) })).toThrow();
    expect(() => call('remoteClient:confirm-sas', undefined)).toThrow();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.removePeer).not.toHaveBeenCalled();
    expect(client.confirmSas).not.toHaveBeenCalled();
  });

  it('rejects a non-allowlisted send type', () => {
    expect(() => call('remoteClient:send', { peerId: 'p1', type: 'cmd:rm-rf' })).toThrow();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('forwards a valid send', async () => {
    const type = [...ALLOWED_COMMANDS][0];
    await expect(call('remoteClient:send', { peerId: 'p1', type, payload: { a: 1 } })).resolves.toEqual({ ok: true });
    expect(client.send).toHaveBeenCalledWith('p1', type, { a: 1 });
  });

  it('forwards peer events and status changes to the renderer', async () => {
    let cb;
    client.onEvent.mockImplementationOnce((_id, fn) => { cb = fn; return () => {}; });
    await call('remoteClient:connect', { peerId: 'p1' });
    cb({ type: 'event:pty:data', payload: { d: 1 } });
    expect(sends).toContainEqual({ channel: 'remoteClient:event', payload: { peerId: 'p1', type: 'event:pty:data', payload: { d: 1 } } });
    expect(sends.some((s) => s.channel === 'remoteClient:status' && s.payload.peerId === 'p1')).toBe(true);
  });
});
