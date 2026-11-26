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

test('SERVICE_TOOL_NAMES is exactly the seven service tools', () => {
  expect(SERVICE_TOOL_NAMES).toEqual([
    'feedback_list_projects', 'feedback_open_session', 'macro_list', 'macro_run', 'epic_get', 'events_read', 'project_create',
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
    projectRoot: null,
    pubKey: PUBKEY,
    relayClientId: RELAY_ID,
    pairedAt: clock,
    lastSeenAt: clock,
    pairedVia: 'window',
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

test('createPending requires an absolute projectRoot when scope grants project_create', async () => {
  const withTool = { ...GOOD, scope: ['feedback_open_session', 'project_create'] };
  await expect(store.createPending(withTool)).rejects.toThrow(/projectRoot/);
  await expect(store.createPending({ ...withTool, projectRoot: '' })).rejects.toThrow(/projectRoot/);
  await expect(store.createPending({ ...withTool, projectRoot: 'rel/Projects' })).rejects.toThrow(/projectRoot/);
  await expect(store.createPending({ ...withTool, projectRoot: '/home/u/Pro\0jects' })).rejects.toThrow(/projectRoot/);
  expect(store.listPending()).toEqual([]);
  const p = await store.createPending({ ...withTool, projectRoot: '/home/u/Projects/../Projects/' });
  expect(store.listPending()[0].projectRoot).toBe('/home/u/Projects');
  const svc = await store.confirmPending(p.pairingId, PUBKEY, { relayClientId: null });
  expect(svc.projectRoot).toBe('/home/u/Projects');
  expect(store.findByPubKey(PUBKEY).projectRoot).toBe('/home/u/Projects');
  const again = createServicePairings({ filePath, now: () => clock });
  expect(again.list()[0].projectRoot).toBe('/home/u/Projects');
});

test('projectRoot is stored as null when scope lacks project_create', async () => {
  await store.createPending({ ...GOOD, projectRoot: '/home/u/Projects' });
  expect(store.listPending()[0].projectRoot).toBeNull();
});

test('a stored record without projectRoot loads as null', async () => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    pending: [{ pairingId: 'p1', name: 'Old', homeCwd: '/h', scope: ['epic_get'], createdAt: clock, expiresAt: clock + 1000 }],
    services: [{ serviceId: 's1', name: 'Old', homeCwd: '/h', scope: ['epic_get'], pubKey: 'k', relayClientId: null, pairedAt: 1, lastSeenAt: 1 }],
  }));
  const old = createServicePairings({ filePath, now: () => clock });
  expect(old.list()[0].projectRoot).toBeNull();
  expect(old.listPending()[0].projectRoot).toBeNull();
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

test('cancelPending removes a pending pairing: no longer listed, confirmable, or on disk', async () => {
  const { pairingId } = await store.createPending(GOOD);
  const other = await store.createPending({ ...GOOD, name: 'Other' });
  expect(await store.cancelPending(pairingId)).toBe(true);
  expect(store.listPending().map((p) => p.pairingId)).toEqual([other.pairingId]);
  expect(readFile().pending.map((p) => p.pairingId)).toEqual([other.pairingId]);
  await expect(store.confirmPending(pairingId, PUBKEY, { relayClientId: RELAY_ID })).rejects.toThrow(/no pending pairing/);
  expect(store.list()).toEqual([]);
  // A fresh store reads the cancel back from disk.
  const reread = createServicePairings({ filePath, now: () => clock });
  expect(reread.listPending().map((p) => p.pairingId)).toEqual([other.pairingId]);
});

test('cancelPending of an unknown id resolves false and leaves state alone', async () => {
  const { pairingId } = await store.createPending(GOOD);
  expect(await store.cancelPending('8d1c2b3a-0000-4000-8000-000000000000')).toBe(false);
  expect(await store.cancelPending(pairingId)).toBe(true);
  expect(await store.cancelPending(pairingId)).toBe(false);
  expect(store.listPending()).toEqual([]);
});

test('cancelPending of a non-string or empty pairingId resolves false and never touches the file', async () => {
  for (const bad of [undefined, null, '', 42, {}, ['x']]) {
    expect(await store.cancelPending(bad)).toBe(false);
  }
  expect(fs.existsSync(filePath)).toBe(false);
  const { pairingId } = await store.createPending(GOOD);
  const before = fs.readFileSync(filePath, 'utf8');
  const mtime = fs.statSync(filePath).mtimeMs;
  for (const bad of [undefined, '', 0]) {
    expect(await store.cancelPending(bad)).toBe(false);
  }
  expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  expect(fs.statSync(filePath).mtimeMs).toBe(mtime);
  expect(store.listPending().map((p) => p.pairingId)).toEqual([pairingId]);
});

test('pairedVia defaults to window, accepts local, rejects others, and carries onto the service', async () => {
  await store.createPending(GOOD);
  expect(store.listPending()[0].pairedVia).toBe('window');
  await expect(store.createPending({ ...GOOD, pairedVia: 'phone' })).rejects.toThrow(/pairedVia/);
  const l = await store.createPending({ ...GOOD, pairedVia: 'local' });
  expect(store.listPending().find((p) => p.pairingId === l.pairingId).pairedVia).toBe('local');
  const svc = await store.confirmPending(l.pairingId, PUBKEY, { relayClientId: RELAY_ID });
  expect(svc.pairedVia).toBe('local');
});

test('a legacy record without pairedVia reads as window', async () => {
  await store.createPending(GOOD);
  await store.confirmPending(store.listPending()[0].pairingId, PUBKEY, { relayClientId: RELAY_ID });
  const raw = readFile();
  delete raw.services[0].pairedVia;
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const fresh = createServicePairings({ filePath, now: () => clock });
  expect(fresh.list()[0].pairedVia).toBe('window');
});
