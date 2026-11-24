/**
 * siteFeedbackService.test.cjs — the one implementation of widget settings + inbox actions,
 * against relayBoxesMock (real relay client), a temp keystore (SM_SCHEDULER_HOME) and a temp
 * project feedback-inbox.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/siteFeedbackService.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../../../config.cjs');
const { startRelayBoxesMock } = require('./helpers/relayBoxesMock.cjs');
const { createRelayClient } = require('../feedbackRelayClient.cjs');
const keystore = require('../feedbackBoxKeys.cjs');
const inbox = require('../siteFeedbackInbox.cjs');
const svcMod = require('../siteFeedbackService.cjs');

const TOKEN = 'dtok-' + crypto.randomBytes(8).toString('hex');
const CLERK = 'clerk-' + crypto.randomBytes(8).toString('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** @type {any} */ let mock;
/** @type {string} */ let home;
/** @type {string} */ let cwd;
/** @type {string|undefined} */ let prevHome;

/** fetch that strips the client's /api/sm-relay prefix so the mock sees /boxes... */
function stripFetch(/** @type {any} */ extraHeaders = {}) {
  return (/** @type {string} */ url, /** @type {any} */ init) => fetch(String(url).replace('/api/sm-relay', ''), {
    ...init, headers: { ...(init.headers || {}), ...extraHeaders },
  });
}

/** @param {{ token?: string|null, headers?: any, mockOpts?: any }} [o] */
async function makeService(o = {}) {
  if (o.mockOpts) {
    await mock.stop();
    mock = await startRelayBoxesMock({ deviceToken: TOKEN, clerkToken: CLERK, ...o.mockOpts });
  }
  const token = o.token === undefined ? TOKEN : o.token;
  const relay = createRelayClient({
    baseUrl: mock.baseUrl, getDeviceToken: () => token, fetchImpl: /** @type {any} */ (stripFetch(o.headers)),
  });
  return svcMod.createSiteFeedbackService({ relay, keystore, inbox });
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-svc-home-'));
  process.env.SM_SCHEDULER_HOME = home;
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-svc-proj-')));
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  config.addAllowedRoot(cwd);
  mock = await startRelayBoxesMock({ deviceToken: TOKEN, clerkToken: CLERK });
});

afterEach(async () => {
  await mock.stop();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.rm(cwd, { recursive: true, force: true });
});

test('createWidget normalises origins, stores the key and returns the exact snippet', async () => {
  const svc = await makeService();
  const r = await svc.createWidget({
    cwd, label: 'Three Winds',
    allowedOrigins: ['https://Site.Example/path?q=1', 'https://site.example', 'http://localhost:5173/', 'http://127.0.0.1'],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.boxId).toMatch(/^[0-9A-Z]{8}$/);
  expect(r.fingerprint).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(r.snippet).toBe(
    `<script src="https://bilko.run/projects/session-manager/widget/v1/feedback.js" data-key="fbk1_${r.boxId}.${r.fingerprint}" async></script>`,
  );
  const box = mock.state.boxes.get(r.boxId);
  expect(box.allowedOrigins).toEqual(['https://site.example', 'http://localhost:5173', 'http://127.0.0.1']);
  expect(box.label).toBe('Three Winds');
  const local = await keystore.listBoxes({ projectCwd: cwd });
  expect(local).toHaveLength(1);
  expect(local[0].fingerprint).toBe(r.fingerprint);
  expect(local[0].publicKey).toBe(box.publicKey);
  const jwk = await keystore.getPrivateKey(r.boxId);
  expect(jwk && typeof jwk.d).toBe('string');
});

test('createWidget rejects bad origins before touching the relay', async () => {
  const svc = await makeService();
  const bad = [
    [],
    ['http://site.example'],
    ['ftp://site.example'],
    ['not a url'],
    Array.from({ length: 11 }, (_, i) => `https://s${i}.example`),
  ];
  for (const allowedOrigins of bad) {
    const r = await svc.createWidget({ cwd, label: 'X', allowedOrigins });
    expect(r).toMatchObject({ ok: false, error: 'invalid_allowed_origins' });
  }
  // 11 entries that dedupe to 1 are fine.
  const dup = await svc.createWidget({ cwd, label: 'X', allowedOrigins: Array(11).fill('https://a.example/') });
  expect(dup.ok).toBe(true);
  expect(mock.state.boxes.size).toBe(1);
  expect(svcMod.normalizeOrigins(['https://a.example:443/x'])).toEqual({ ok: true, origins: ['https://a.example'] });
});

test('listWidgets merges relay state and marks a box the relay lost as gone', async () => {
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  const b = await svc.createWidget({ cwd, label: 'B', allowedOrigins: ['https://b.example'] });
  if (!a.ok || !b.ok) throw new Error('create failed');
  mock.state.envelopes.get(a.boxId).push({ envelopeId: 'e1', bytes: 5, body: Buffer.alloc(5) });
  mock.state.boxes.get(a.boxId).label = 'A renamed on relay';
  mock.state.boxes.delete(b.boxId);

  const r = await svc.listWidgets({ cwd });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const byId = Object.fromEntries(r.widgets.map((w) => [w.boxId, w]));
  expect(byId[a.boxId]).toMatchObject({
    label: 'A renamed on relay', allowedOrigins: ['https://a.example'], state: 'open', pending: 1, hint: null,
    snippet: svcMod.snippetFor(a.boxId, a.fingerprint),
  });
  expect(byId[b.boxId]).toMatchObject({
    state: 'gone', hint: 'This widget no longer exists on bilko.run - create a new one', label: 'B',
  });
  // cwd filter
  const other = await svc.listWidgets({ cwd: '/nowhere' });
  expect(other.ok && other.widgets).toEqual([]);
  const all = await svc.listWidgets();
  expect(all.ok && all.widgets.length).toBe(2);
});

test('listWidgets without a paired desktop still lists local boxes with relayError', async () => {
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  expect(a.ok).toBe(true);
  const offline = await makeService({ token: null });
  const r = await offline.listWidgets({ cwd });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.widgets[0].state).toBe('unknown');
  expect(/** @type {any} */ (r).relayError).toMatchObject({ error: 'not_linked' });
});

test('updateWidget patches label, origins and state; rejects bad input', async () => {
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  if (!a.ok) throw new Error('create failed');
  const r = await svc.updateWidget({
    boxId: a.boxId, label: 'New', allowedOrigins: ['https://B.example/x', 'https://b.example'], state: 'paused',
  });
  expect(r).toMatchObject({ ok: true, widget: { label: 'New', allowedOrigins: ['https://b.example'], state: 'paused' } });
  expect(mock.state.boxes.get(a.boxId).state).toBe('paused');
  expect(await svc.updateWidget({ boxId: a.boxId, state: /** @type {any} */ ('closed') })).toMatchObject({ ok: false, error: 'invalid_state' });
  expect(await svc.updateWidget({ boxId: a.boxId, allowedOrigins: ['http://x.example'] })).toMatchObject({ ok: false, error: 'invalid_allowed_origins' });
  expect(await svc.updateWidget({ boxId: a.boxId })).toMatchObject({ ok: false, error: 'invalid_input' });
  expect(await svc.updateWidget({ boxId: 'NOPE0000', label: 'x' })).toMatchObject({ ok: false, error: 'not_found' });
  mock.state.boxes.delete(a.boxId);
  expect(await svc.updateWidget({ boxId: a.boxId, label: 'x' })).toMatchObject({
    ok: false, error: 'box_not_found', message: svcMod.GONE_HINT,
  });
});

test('deleteWidget deletes on the relay then locally; a gone box is cleaned up locally', async () => {
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  const b = await svc.createWidget({ cwd, label: 'B', allowedOrigins: ['https://b.example'] });
  if (!a.ok || !b.ok) throw new Error('create failed');
  expect(await svc.deleteWidget({ boxId: a.boxId })).toEqual({ ok: true, boxId: a.boxId });
  expect(mock.state.boxes.has(a.boxId)).toBe(false);
  expect(await keystore.getPrivateKey(a.boxId)).toBeNull();
  mock.state.boxes.delete(b.boxId);
  expect((await svc.deleteWidget({ boxId: b.boxId })).ok).toBe(true);
  expect(await keystore.listBoxes()).toEqual([]);
  expect(await svc.deleteWidget({ boxId: a.boxId })).toMatchObject({ ok: false, error: 'not_found' });
});

test('deleteWidget keeps the local key when the relay refuses', async () => {
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  if (!a.ok) throw new Error('create failed');
  const offline = await makeService({ token: null });
  expect(await offline.deleteWidget({ boxId: a.boxId })).toMatchObject({ ok: false, error: 'not_linked' });
  expect(await keystore.getPrivateKey(a.boxId)).not.toBeNull();
});

test('getSnippet returns the stored box snippet', async () => {
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  if (!a.ok) throw new Error('create failed');
  expect(await svc.getSnippet({ boxId: a.boxId })).toEqual({ ok: true, boxId: a.boxId, fingerprint: a.fingerprint, snippet: a.snippet });
  expect(await svc.getSnippet({ boxId: 'NOPE0000' })).toMatchObject({ ok: false, error: 'not_found' });
});

test('relay error codes pass through verbatim with a one-line explanation', async () => {
  const input = { cwd, label: 'A', allowedOrigins: ['https://a.example'] };
  const M = svcMod.RELAY_ERROR_MESSAGES;

  const unlinked = await (await makeService({ token: null })).createWidget(input);
  expect(unlinked).toMatchObject({ ok: false, error: 'not_linked', message: M.not_linked });

  const notEnabled = await (await makeService({ mockOpts: { allowEmails: ['owner@example.com'] } })).createWidget(input);
  expect(notEnabled).toMatchObject({
    ok: false, error: 'not_enabled', status: 403,
    message: 'Website feedback is not enabled for this bilko.run account yet',
  });

  const limited = await makeService({ mockOpts: { maxBoxesPerAccount: 1 } });
  expect((await limited.createWidget(input)).ok).toBe(true);
  expect(await limited.createWidget(input)).toMatchObject({ ok: false, error: 'box_limit_reached', message: M.box_limit_reached });

  const clerk = await makeService({ token: CLERK });
  expect(await clerk.createWidget(input)).toMatchObject({
    ok: false, error: 'device_token_required', message: M.device_token_required,
  });

  // rate_limited: only the submit route rate-limits on the mock, so a stub relay answers 429.
  const stubRelay = /** @type {any} */ ({
    createBox: async () => ({ ok: false, status: 429, error: 'rate_limited', retryAfterSec: 30 }),
  });
  const rl = await svcMod.createSiteFeedbackService({ relay: stubRelay, keystore, inbox }).createWidget(input);
  expect(rl).toEqual({ ok: false, error: 'rate_limited', message: M.rate_limited, status: 429, retryAfterSec: 30 });

  for (const code of ['not_linked', 'not_enabled', 'box_limit_reached', 'device_token_required', 'rate_limited']) {
    const m = /** @type {any} */ (M)[code];
    expect(typeof m).toBe('string');
    expect(m).not.toMatch(/\n/);
  }
  // Nothing reached the keystore on any failure.
  expect((await keystore.listBoxes()).length).toBe(1);
});

/** Seed one inbox item directly through the single writer. */
async function seedItem(hostId = 'FB-ABCDE', screenshot = PNG) {
  await inbox.writeItem({
    cwd, hostId, boxId: 'BOX00001', receivedAt: '2026-11-23T10:00:00.000Z', origin: 'https://a.example',
    report: { schemaVersion: 1, clientReportId: crypto.randomUUID(), title: 'Broken', type: 'bug', user: null },
    screenshot, annotated: PNG,
  });
}

test('inbox actions delegate to siteFeedbackInbox', async () => {
  const svc = await makeService();
  await seedItem('FB-ABCDE');
  await seedItem('FB-NOPNG', Buffer.from('GIF89a-not-a-png'));

  const list = await svc.listItems({ cwd });
  expect(list.ok && list.items.map((i) => i.hostId).sort()).toEqual(['FB-ABCDE', 'FB-NOPNG']);
  expect(await svc.listItems({ cwd, status: 'resolved' })).toEqual({ ok: true, items: [] });

  const got = await svc.getItem({ cwd, hostId: 'FB-ABCDE' });
  expect(got).toMatchObject({ ok: true, item: { meta: { hostId: 'FB-ABCDE', status: 'open' }, report: { title: 'Broken' } } });
  expect(await svc.getItem({ cwd, hostId: 'FB-ZZZZZ' })).toMatchObject({ ok: false, error: 'not_found' });
  expect(await svc.getItem({ cwd, hostId: '../etc' })).toMatchObject({ ok: false, error: 'invalid_input' });

  const img = await svc.getImage({ cwd, hostId: 'FB-ABCDE', which: 'screenshot' });
  expect(img).toEqual({ ok: true, hostId: 'FB-ABCDE', which: 'screenshot', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
  expect(await svc.getImage({ cwd, hostId: 'FB-NOPNG', which: 'screenshot' })).toMatchObject({ ok: false, error: 'not_png' });
  expect((await svc.getImage({ cwd, hostId: 'FB-NOPNG' })).ok).toBe(true);

  const st = await svc.setStatus({ cwd, hostId: 'FB-ABCDE', status: 'resolved', note: 'fixed' });
  expect(st).toMatchObject({ ok: true, meta: { status: 'resolved', statusNote: 'fixed' } });
  expect(await svc.setStatus({ cwd, hostId: 'FB-ABCDE', status: /** @type {any} */ ('bogus') })).toMatchObject({ ok: false, error: 'invalid_input' });
  expect(await svc.setStatus({ cwd, hostId: 'FB-ZZZZZ', status: 'open' })).toMatchObject({ ok: false, error: 'not_found' });

  expect(await svc.linkEpic({ cwd, hostId: 'FB-ABCDE', epicId: 'epic-123' })).toMatchObject({ ok: true, meta: { epicId: 'epic-123' } });
  expect(await svc.linkEpic({ cwd, hostId: 'FB-ABCDE', epicId: '../x' })).toMatchObject({ ok: false, error: 'invalid_input' });

  expect(await svc.removeItem({ cwd, hostId: 'FB-NOPNG' })).toEqual({ ok: true, hostId: 'FB-NOPNG' });
  expect(await svc.getItem({ cwd, hostId: 'FB-NOPNG' })).toMatchObject({ ok: false, error: 'not_found' });
  expect(await svc.removeItem({ cwd, hostId: 'FB-NOPNG' })).toMatchObject({ ok: false, error: 'not_found' });
  expect(await svc.removeItem({ cwd, hostId: '../etc' })).toMatchObject({ ok: false, error: 'invalid_input' });
});

test('drainNow and startDrainLoop delegate to feedbackBoxDrain with the service deps', async () => {
  /** @type {any[]} */ const seen = [];
  const relay = /** @type {any} */ ({ marker: 'relay' });
  const drain = {
    drainOnce: async (/** @type {any} */ d) => { seen.push(['once', d]); return { stored: 2, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] }; },
    startDrainLoop: (/** @type {any} */ o) => {
      seen.push(['loop', o]);
      return { drainNow: async () => ({ stored: 5, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] }), stop: () => { seen.push(['stop']); } };
    },
  };
  const svc = svcMod.createSiteFeedbackService({ relay, keystore, inbox, drain });
  expect(await svc.drainNow()).toMatchObject({ ok: true, stored: 2 });
  expect(seen[0][1]).toEqual({ relay, keystore, inbox });
  const h = svc.startDrainLoop({ intervalMs: 1000 });
  expect(svc.startDrainLoop()).toBe(h);
  expect(seen.filter((s) => s[0] === 'loop')).toHaveLength(1);
  expect(seen[1][1]).toMatchObject({ relay, keystore, inbox, intervalMs: 1000 });
  expect(await svc.drainNow()).toMatchObject({ ok: true, stored: 5 });
  svc.stopDrainLoop();
  expect(seen.at(-1)).toEqual(['stop']);
});

test('drainNow runs a real pass against the relay mock', async () => {
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  expect(a.ok).toBe(true);
  expect(await svc.drainNow()).toEqual({ ok: true, stored: 0, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] });
});

test('getIdentitySecret creates once, rotateIdentitySecret replaces, list output never carries it', async () => {
  expect(typeof svcMod.getIdentitySecret).toBe('function');
  expect(typeof svcMod.rotateIdentitySecret).toBe('function');
  const svc = await makeService();
  const a = await svc.createWidget({ cwd, label: 'A', allowedOrigins: ['https://a.example'] });
  if (!a.ok) throw new Error('create failed');
  const g1 = await svc.getIdentitySecret(a.boxId);
  expect(g1.ok).toBe(true);
  if (!g1.ok) return;
  expect(g1.boxId).toBe(a.boxId);
  expect(g1.identitySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const g2 = await svc.getIdentitySecret({ boxId: a.boxId });
  expect(g2).toEqual(g1);
  const r = await svc.rotateIdentitySecret(a.boxId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.identitySecret).not.toBe(g1.identitySecret);
  expect(await svc.getIdentitySecret(a.boxId)).toEqual(r);
  expect(await svc.getIdentitySecret('NOPE0000')).toMatchObject({ ok: false, error: 'not_found' });
  expect(await svc.rotateIdentitySecret('NOPE0000')).toMatchObject({ ok: false, error: 'not_found' });
  expect(await svc.getIdentitySecret('')).toMatchObject({ ok: false, error: 'invalid_input' });
  const listed = JSON.stringify([await svc.listWidgets({ cwd }), await svc.getSnippet({ boxId: a.boxId }), await keystore.listBoxes()]);
  for (const s of [g1.identitySecret, r.identitySecret]) expect(listed).not.toContain(s);
  expect(listed).not.toContain('identitySecret');
  // the secret never reaches the relay
  const relayText = JSON.stringify([...mock.state.boxes.values()]);
  for (const s of [g1.identitySecret, r.identitySecret]) expect(relayText).not.toContain(s);
});
