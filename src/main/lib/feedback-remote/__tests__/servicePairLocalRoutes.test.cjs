// @ts-check
/**
 * servicePairLocalRoutes.test.cjs — the two local-pairing admin routes against a stub webRemote.
 * Run: timeout 180 npx vitest run src/main/lib/feedback-remote/__tests__/servicePairLocalRoutes.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');

const TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-local-token-'));
fs.mkdirSync(path.join(TOKEN_DIR, '.claude'));
process.env.SM_ADMIN_TOKEN_PATH = path.join(TOKEN_DIR, '.claude', 'admin-api.json');
const CONFIG_PATH = require.resolve('../../../config.cjs');
const hadConfigCached = Boolean(require.cache[CONFIG_PATH]);
require(CONFIG_PATH).addAllowedRoot(TOKEN_DIR);

const { createAdminHttp } = require('../localAdminHttp.cjs');
const { registerAdminRoute } = require('../servicePairLocalRoutes.cjs');

/** @type {ReturnType<typeof createAdminHttp>} */ let admin;
/** @type {any} */ let wr;

beforeEach(() => {
  wr = {
    servicePairStartLocal: vi.fn(async () => ({ ok: true, code: 'ABC123', pairingId: 'p1', codeExpiresAt: 99, deviceId: 'd1' })),
    confirmServiceSasLocal: vi.fn(async () => ({ ok: true, service: { serviceId: 's1', name: 'Kiln', pubKey: 'SECRET' } })),
  };
  admin = createAdminHttp();
  registerAdminRoute(admin, { webRemote: wr });
});
afterEach(async () => {
  await admin.stop();
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
  if (!hadConfigCached) delete require.cache[CONFIG_PATH];
});

const START = '/admin/services/pair-local';
const CONFIRM = '/admin/services/pair-local/confirm';
const good = { name: 'Kiln', homeCwd: '/home/u/Self/kiln', tools: ['feedback_open_session'] };

test('start succeeds and maps tools to scope', async () => {
  const out = await admin.invoke('POST', START, { body: good });
  expect(out.status).toBe(200);
  expect(out.json).toEqual({ ok: true, code: 'ABC123', pairingId: 'p1', codeExpiresAt: 99, deviceId: 'd1' });
  expect(wr.servicePairStartLocal).toHaveBeenCalledWith({ name: 'Kiln', homeCwd: '/home/u/Self/kiln', scope: ['feedback_open_session'], projectRoot: undefined });
});

test("Kiln's exact input is accepted", async () => {
  const body = {
    name: 'Kiln', homeCwd: '/home/u/Self/kiln',
    tools: ['feedback_list_projects', 'feedback_open_session', 'epic_get', 'project_create'],
    projectRoot: '/home/u/Projects',
  };
  const out = await admin.invoke('POST', START, { body });
  expect(out.status).toBe(200);
  expect(wr.servicePairStartLocal).toHaveBeenCalledWith({ name: 'Kiln', homeCwd: body.homeCwd, scope: body.tools, projectRoot: body.projectRoot });
});

test('confirm succeeds and redacts pubKey', async () => {
  const out = await admin.invoke('POST', CONFIRM, { body: { pairingId: 'p1', sas: '123456' } });
  expect(out.status).toBe(200);
  expect(out.json).toEqual({ ok: true, service: { serviceId: 's1', name: 'Kiln' } });
  expect(wr.confirmServiceSasLocal).toHaveBeenCalledWith('p1', '123456');
});

test.each([
  ['empty name', { ...good, name: '' }],
  ['long name', { ...good, name: 'x'.repeat(81) }],
  ['relative homeCwd', { ...good, homeCwd: 'rel/path' }],
  ['no tools', { ...good, tools: [] }],
  ['unknown tool', { ...good, tools: ['nope'] }],
  ['extra key', { ...good, extra: 1 }],
])('start rejects bad body: %s', async (_n, body) => {
  const out = await admin.invoke('POST', START, { body });
  expect(out.status).toBe(400);
  expect(out.json.ok).toBe(false);
  expect(wr.servicePairStartLocal).not.toHaveBeenCalled();
});

test.each([
  ['short sas', { pairingId: 'p', sas: '12345' }],
  ['letters', { pairingId: 'p', sas: 'abcdef' }],
  ['extra key', { pairingId: 'p', sas: '123456', x: 1 }],
  ['no pairingId', { sas: '123456' }],
])('confirm rejects bad body: %s', async (_n, body) => {
  const out = await admin.invoke('POST', CONFIRM, { body });
  expect(out.status).toBe(400);
  expect(wr.confirmServiceSasLocal).not.toHaveBeenCalled();
});

test.each([
  ['web_remote_off', 409], ['no_paired_device', 409],
  ['unknown tool', 400], ['projectRoot must be an existing folder in your home folder', 400],
])('start error %s -> %i', async (error, status) => {
  wr.servicePairStartLocal.mockResolvedValueOnce({ ok: false, error });
  const out = await admin.invoke('POST', START, { body: good });
  expect(out.status).toBe(status);
  expect(out.json).toEqual({ ok: false, error });
});

test.each([
  ['web_remote_off', 409], ['not_local_pairing', 404], ['no_pending_service', 404], ['sas_mismatch', 403],
])('confirm error %s -> %i', async (error, status) => {
  wr.confirmServiceSasLocal.mockResolvedValueOnce({ ok: false, error });
  const out = await admin.invoke('POST', CONFIRM, { body: { pairingId: 'p1', sas: '123456' } });
  expect(out.status).toBe(status);
  expect(out.json).toEqual({ ok: false, error });
});

test('a request without the bearer token is 401 and creates no pairing', async () => {
  const { port } = await admin.start();
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: START, headers: { 'Content-Type': 'application/json' } },
      (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify(good));
  });
  expect(status).toBe(401);
  expect(wr.servicePairStartLocal).not.toHaveBeenCalled();
});
