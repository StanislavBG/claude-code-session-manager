/**
 * servicePairings.test.cjs — store of services paired over the Web Remote relay.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/servicePairings.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServicePairings, SERVICE_TOOL_NAMES, PENDING_TTL_MS, MAX_OPENED } = require('../servicePairings.cjs');

const RELAY_ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const PUBKEY = 'BPubKeyBase64ForTests0123456789';

let tmp;
let filePath;
let clock;
let store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'service-pairings-'));
  filePath = path.join(tmp, 'nested', 'remote-services.json');
  clock = 1_800_000_000_000;
  store = createServicePairings({ filePath, now: () => clock });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readFile() {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const SITE = '/home/u/Projects/site';
const OTHER = '/home/u/Projects/other';
const GOOD = { name: 'Kiln Service', homeCwd: '/home/u/Projects/Kiln', scope: ['feedback_open_session', 'epic_get'] };

test('SERVICE_TOOL_NAMES is exactly the six service tools', () => {
  expect(SERVICE_TOOL_NAMES).toEqual([
    'feedback_list_projects', 'feedback_open_session', 'macro_list', 'macro_run', 'epic_get', 'events_read',
  ]);
  expect(Object.isFrozen(SERVICE_TOOL_NAMES)).toBe(true);
});

test('createPending returns a pairingId and a 10-minute expiry, listed and persisted', async () => {
  const p = await store.createPending(GOOD);
  expect(p.pairingId).toMatch(/^[0-9a-f-]{36}$/);
  expect(p.expiresAt).toBe(clock + 10 * 60 * 1000);
  expect(PENDING_TTL_MS).toBe(10 * 60 * 1000);
  const pending = store.listPending();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ pairingId: p.pairingId, name: GOOD.name, homeCwd: GOOD.homeCwd, scope: GOOD.scope });
  expect(readFile().pending).toHaveLength(1);
});

test('confirmPending with relayClientId creates the service and consumes the pending entry', async () => {
  const p = await store.createPending(GOOD);
  clock += 1000;
  const svc = await store.confirmPending(p.pairingId, PUBKEY, { relayClientId: RELAY_ID });
  expect(svc).toEqual({
    serviceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    name: GOOD.name,
    homeCwd: GOOD.homeCwd,
    scope: GOOD.scope,
    pubKey: PUBKEY,
    relayClientId: RELAY_ID,
    pairedAt: clock,
    lastSeenAt: clock,
  });
  expect(store.listPending()).toEqual([]);
  expect(store.findByPubKey(PUBKEY)).toMatchObject({ serviceId: svc.serviceId });
  expect(store.findByPubKey('other')).toBeNull();
  expect(store.list()).toHaveLength(1);
  await expect(store.confirmPending(p.pairingId, 'x', { relayClientId: null })).rejects.toThrow(/pending/i);

  // persisted: a fresh store over the same file sees the service
  const again = createServicePairings({ filePath, now: () => clock });
  expect(again.findByPubKey(PUBKEY)).toMatchObject({ serviceId: svc.serviceId, relayClientId: RELAY_ID });
});

test('relayClientId must be a UUID or null', async () => {
  const p = await store.createPending(GOOD);
  await expect(store.confirmPending(p.pairingId, PUBKEY, { relayClientId: 'not-a-uuid' })).rejects.toThrow(/relayClientId/);
  const svc = await store.confirmPending(p.pairingId, PUBKEY, { relayClientId: null });
  expect(svc.relayClientId).toBeNull();
});

test('an expired pending entry cannot be confirmed and drops from listPending', async () => {
  const p = await store.createPending(GOOD);
  clock += PENDING_TTL_MS + 1;
  expect(store.listPending()).toEqual([]);
  await expect(store.confirmPending(p.pairingId, PUBKEY, { relayClientId: null })).rejects.toThrow(/expired|pending/i);
  expect(store.list()).toEqual([]);
});

test('createPending refuses bad scope, name and homeCwd', async () => {
  await expect(store.createPending({ ...GOOD, scope: [] })).rejects.toThrow(/scope/);
  await expect(store.createPending({ ...GOOD, scope: ['scheduler_create_prd'] })).rejects.toThrow(/unknown tool/);
  await expect(store.createPending({ ...GOOD, name: 'x'.repeat(65) })).rejects.toThrow(/name/);
  await expect(store.createPending({ ...GOOD, name: '' })).rejects.toThrow(/name/);
  await expect(store.createPending({ ...GOOD, homeCwd: 'relative/path' })).rejects.toThrow(/homeCwd/);
  expect(store.listPending()).toEqual([]);
  await expect(store.createPending({ ...GOOD, name: 'x'.repeat(64) })).resolves.toBeTruthy();
});

test('revoke removes the service and its ledger', async () => {
  const p = await store.createPending(GOOD);
  const svc = await store.confirmPending(p.pairingId, PUBKEY, { relayClientId: RELAY_ID });
  await store.recordOpened(svc.serviceId, { cwd: SITE, epicId: 'epic-1' });
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-1')).toBe(true);
  expect(await store.revoke(svc.serviceId)).toBe(true);
  expect(store.list()).toEqual([]);
  expect(store.findByPubKey(PUBKEY)).toBeNull();
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-1')).toBe(false);
  expect(readFile().services).toEqual([]);
  expect(JSON.stringify(readFile())).not.toContain('epic-1');
  expect(await store.revoke(svc.serviceId)).toBe(false);
});

test('recordOpened keeps the newest 1000 entries per service', async () => {
  expect(MAX_OPENED).toBe(1000);
  const p = await store.createPending(GOOD);
  const svc = await store.confirmPending(p.pairingId, PUBKEY, { relayClientId: null });
  for (let i = 0; i < 1005; i++) {
    clock += 1;
    await store.recordOpened(svc.serviceId, { cwd: SITE, epicId: `epic-${i}` });
  }
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-0')).toBe(false);
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-4')).toBe(false);
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-5')).toBe(true);
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-1004')).toBe(true);
  const rec = readFile().services[0];
  expect(rec.opened).toHaveLength(1000);
  await expect(store.recordOpened('missing', { cwd: SITE, epicId: 'epic-x' })).rejects.toThrow(/service/);
});

test('recordOpened stores cwd + epicId + optional externalRef; hasOpened matches both', async () => {
  const p = await store.createPending(GOOD);
  const svc = await store.confirmPending(p.pairingId, PUBKEY, { relayClientId: null });
  await store.recordOpened(svc.serviceId, { cwd: SITE, epicId: 'epic-1', externalRef: 'kiln:1' });
  await store.recordOpened(svc.serviceId, { cwd: `${OTHER}/`, epicId: 'epic-2' });
  expect(readFile().services[0].opened).toEqual([
    { cwd: SITE, epicId: 'epic-1', externalRef: 'kiln:1', at: clock },
    { cwd: OTHER, epicId: 'epic-2', at: clock },
  ]);
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-1')).toBe(true);
  expect(store.hasOpened(svc.serviceId, `${SITE}/`, 'epic-1')).toBe(true);
  // Same id, different project: refused.
  expect(store.hasOpened(svc.serviceId, OTHER, 'epic-1')).toBe(false);
  expect(store.hasOpened(svc.serviceId, SITE, 'epic-2')).toBe(false);
  expect(store.hasOpened(svc.serviceId, OTHER, 'epic-2')).toBe(true);
  // An id alone (no cwd) never matches.
  expect(store.hasOpened(svc.serviceId, 'epic-1')).toBe(false);
  expect(store.hasOpened(svc.serviceId, undefined, 'epic-1')).toBe(false);
  // Re-recording the same pair replaces, it does not duplicate.
  await store.recordOpened(svc.serviceId, { cwd: SITE, epicId: 'epic-1' });
  expect(readFile().services[0].opened.filter((o) => o.epicId === 'epic-1')).toHaveLength(1);
  // The same id in another project is its own entry.
  await store.recordOpened(svc.serviceId, { cwd: OTHER, epicId: 'epic-1' });
  expect(readFile().services[0].opened.filter((o) => o.epicId === 'epic-1')).toHaveLength(2);
  await expect(store.recordOpened(svc.serviceId, 'epic-x')).rejects.toThrow(/entry/);
  await expect(store.recordOpened(svc.serviceId, { cwd: 'relative', epicId: 'epic-x' })).rejects.toThrow(/cwd/);
  await expect(store.recordOpened(svc.serviceId, { epicId: 'epic-x' })).rejects.toThrow(/cwd/);
  await expect(store.recordOpened(svc.serviceId, { cwd: SITE, epicId: '' })).rejects.toThrow(/epicId/);
  await expect(store.recordOpened(svc.serviceId, { cwd: SITE, epicId: 'e', externalRef: 5 })).rejects.toThrow(/externalRef/);
});

test('touchLastSeen updates lastSeenAt', async () => {
  const p = await store.createPending(GOOD);
  const svc = await store.confirmPending(p.pairingId, PUBKEY, { relayClientId: null });
  clock += 5000;
  await store.touchLastSeen(svc.serviceId);
  expect(store.list()[0].lastSeenAt).toBe(clock);
});

test('the file is written at mode 0600', async () => {
  await store.createPending(GOOD);
  if (process.platform !== 'win32') {
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  }
});
