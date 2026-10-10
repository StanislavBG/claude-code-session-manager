'use strict';

/**
 * remoteClientIpc.cjs — IPC surface for the desktop-to-desktop remote client
 * (remoteClient.cjs). Every payload is Zod-validated here, in main. Status
 * changes and peer events are pushed to the renderer on `remoteClient:status`
 * and `remoteClient:event`.
 */

const { ipcMain } = require('electron');
const { z } = require('zod');
const { remoteClient } = require('./remoteClient.cjs');
const { ALLOWED_COMMANDS } = require('./ipcSchemas.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

const STATUS_POLL_MS = 1000;

const peerId = z.string().min(1).max(128);
const schemas = {
  peer: z.object({ peerId }),
  send: z.object({
    peerId,
    type: z.string().min(1).max(128).refine((t) => ALLOWED_COMMANDS.has(t), { message: 'command_not_allowed' }),
    payload: z.unknown().optional(),
  }),
};

function validated(schema, handler) {
  return (_event, payload) => handler(schema.parse(payload));
}

function registerRemoteClientHandlers(getWindow, client = remoteClient) {
  const unsubs = new Map(); // peerId -> unsubscribe for event forwarding
  const lastStatus = new Map(); // peerId -> serialized status

  const toWindow = (channel, payload) => sendIfAlive(getWindow(), channel, payload);

  function publishStatus(id) {
    const status = client.getStatus(id);
    const key = JSON.stringify(status);
    if (lastStatus.get(id) === key) return status;
    lastStatus.set(id, key);
    toWindow('remoteClient:status', { peerId: id, ...status });
    return status;
  }

  function ensureForwarding(id) {
    if (unsubs.has(id)) return;
    unsubs.set(id, client.onEvent(id, (ev) => {
      toWindow('remoteClient:event', { peerId: id, type: ev.type, payload: ev.payload });
    }));
  }

  // remoteClient has no status callback; the socket moves status on its own
  // (pending_sas, failed, idle), so poll for changes on known peers.
  const timer = setInterval(() => {
    for (const p of client.listPeers()) publishStatus(p.peerId);
  }, STATUS_POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  ipcMain.handle('remoteClient:list', () => client.listPeers().map((p) => {
    ensureForwarding(p.peerId);
    return { ...p, ...client.getStatus(p.peerId) };
  }));

  ipcMain.handle('remoteClient:connect', validated(schemas.peer, async ({ peerId: id }) => {
    ensureForwarding(id);
    const connecting = client.connect(id);
    publishStatus(id);
    const status = await connecting;
    publishStatus(id);
    return status;
  }));

  ipcMain.handle('remoteClient:confirm-sas', validated(schemas.peer, ({ peerId: id }) => {
    const res = client.confirmSas(id);
    publishStatus(id);
    return res;
  }));

  ipcMain.handle('remoteClient:remove', validated(schemas.peer, ({ peerId: id }) => {
    client.removePeer(id);
    const off = unsubs.get(id);
    if (off) off();
    unsubs.delete(id);
    lastStatus.delete(id);
    toWindow('remoteClient:status', { peerId: id, status: 'removed', reason: null, sas: null });
    return { ok: true };
  }));

  ipcMain.handle('remoteClient:send', validated(schemas.send, ({ peerId: id, type, payload }) =>
    client.send(id, type, payload)));

  return () => {
    clearInterval(timer);
    for (const off of unsubs.values()) off();
    unsubs.clear();
  };
}

module.exports = { registerRemoteClientHandlers, schemas };
