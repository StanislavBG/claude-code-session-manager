/**
 * webhookRegistry.test.cjs — the loopback-only webhook subscription registry
 * (webhookRegistry.cjs) and its /admin/webhooks routes (eventsAdminRoutes.cjs).
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/webhookRegistry.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let cwd;
let tmpHome;
let prevSchedulerHome;
let reg;

beforeAll(() => {
  prevSchedulerHome = process.env.SM_SCHEDULER_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-webhooks-home-'));
  process.env.SM_SCHEDULER_HOME = tmpHome;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-webhooks-cwd-'));
  reg = require('../webhookRegistry.cjs');
});

afterAll(() => {
  if (prevSchedulerHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedulerHome;
  for (const d of [tmpHome, cwd]) fs.rmSync(d, { recursive: true, force: true });
});

const storePath = () => path.join(cwd, 'session-manager-operations', 'webhooks', 'subscriptions.json');

test('loopback URLs are accepted', () => {
  for (const url of [
    'http://127.0.0.1',
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/hook',
    'http://[::1]:9000/a/b?x=1',
    'http://localhost:3000/events',
    'http://localhost',
  ]) {
    expect(reg.assertLoopbackUrl(url), url).toBe(url);
  }
});

test('remote and DNS-rebinding-style hosts are refused with a named error', () => {
  for (const url of [
    'https://127.0.0.1/hook',
    'http://example.com/hook',
    'http://10.0.0.5/hook',
    'http://0.0.0.0:80/',
    'http://127.0.0.2/',
    'http://127.0.0.1.nip.io/hook',
    'http://localhost.evil.com/hook',
    'http://evil-localhost/',
    'http://localhost./hook',
    'http://127.0.0.1@evil.com/hook',
    'http://user:pw@localhost/hook',
    'http://evil.com#@127.0.0.1/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://127.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://LOCALHOST/',
    'http://localhost:0/',
    'http://localhost:70000/',
    'http://localhost:80 /x',
    'ws://localhost/',
    'file:///etc/passwd',
    '',
    42,
    null,
  ]) {
    let err;
    try { reg.assertLoopbackUrl(url); } catch (e) { err = e; }
    expect(err, String(url)).toBeInstanceOf(reg.WebhookUrlRefusedError);
    expect(err.name).toBe('WebhookUrlRefusedError');
    expect(err.code).toBe('webhook_url_refused');
  }
});

test('kinds are validated against EVENT_KINDS', () => {
  const { EVENT_KINDS } = require('../../epic/epicEventLog.cjs');
  expect(reg.assertKinds([...EVENT_KINDS])).toEqual([...EVENT_KINDS]);
  expect(reg.assertKinds(['job.queued', 'job.queued'])).toEqual(['job.queued']);
  for (const kinds of [[], ['nope.nope'], ['job.queued', 'epic_state_changed'], 'job.queued', undefined, [1]]) {
    let err;
    try { reg.assertKinds(kinds); } catch (e) { err = e; }
    expect(err, JSON.stringify(kinds)).toBeInstanceOf(reg.WebhookKindsInvalidError);
    expect(err.code).toBe('webhook_kinds_invalid');
  }
});

test('add → list → remove round-trip; secret stored 0600 and hidden from list', async () => {
  const a = await reg.addSubscription({ cwd, url: 'http://127.0.0.1:8123/hook', kinds: ['job.queued'] });
  expect(a.id).toMatch(/^wh_[0-9a-f]{16}$/);
  expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
  const b = await reg.addSubscription({ cwd, url: 'http://localhost/x', kinds: ['validator.verdict', 'epic.minted'] });
  expect(b.secret).not.toBe(a.secret);

  const st = fs.statSync(storePath());
  if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);
  const onDisk = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  expect(onDisk.subscriptions.find((s) => s.id === a.id).secret).toBe(a.secret);

  const listed = await reg.listSubscriptions({ cwd });
  expect(listed.map((s) => s.id)).toEqual([a.id, b.id]);
  expect(listed[0]).toMatchObject({ url: 'http://127.0.0.1:8123/hook', kinds: ['job.queued'] });
  expect(listed.every((s) => !('secret' in s))).toBe(true);
  const withSecrets = await reg.listSubscriptions({ cwd, includeSecrets: true });
  expect(withSecrets[0].secret).toBe(a.secret);

  await expect(reg.removeSubscription({ cwd, id: a.id })).resolves.toEqual({ removed: true });
  expect((await reg.listSubscriptions({ cwd })).map((s) => s.id)).toEqual([b.id]);
  await expect(reg.removeSubscription({ cwd, id: a.id })).rejects.toMatchObject({ code: 'webhook_not_found' });
  await reg.removeSubscription({ cwd, id: b.id });
});

test('a refused URL never touches disk', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-webhooks-fresh-'));
  try {
    await expect(reg.addSubscription({ cwd: fresh, url: 'http://evil.com/', kinds: ['job.queued'] }))
      .rejects.toBeInstanceOf(reg.WebhookUrlRefusedError);
    await expect(reg.addSubscription({ cwd: fresh, url: 'http://localhost/', kinds: ['bad.kind'] }))
      .rejects.toBeInstanceOf(reg.WebhookKindsInvalidError);
    expect(fs.existsSync(path.join(fresh, 'session-manager-operations'))).toBe(false);
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('concurrent adds are serialized (none lost)', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-webhooks-conc-'));
  try {
    const ids = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reg.addSubscription({ cwd: fresh, url: `http://127.0.0.1:${9000 + i}/`, kinds: ['job.queued'] })));
    const listed = await reg.listSubscriptions({ cwd: fresh });
    expect(listed.map((s) => s.id).sort()).toEqual(ids.map((x) => x.id).sort());
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

function call(port, token, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ hostname: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('POST/GET/DELETE /admin/webhooks wrap the registry', async () => {
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const { createAdminHttp } = require('../../feedback-remote/localAdminHttp.cjs');
  const admin = createAdminHttp();
  require('../eventsAdminRoutes.cjs').registerAdminRoute(admin);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  const c = (m, p, b) => call(port, token, m, p, b);
  try {
    const ok = await c('POST', '/admin/webhooks', { cwd, url: 'http://[::1]:7000/h', kinds: ['human.message'] });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true });
    expect(ok.json.secret).toMatch(/^[0-9a-f]{64}$/);

    const remote = await c('POST', '/admin/webhooks', { cwd, url: 'http://attacker.example/h', kinds: ['human.message'] });
    expect(remote.status).toBe(400);
    expect(remote.json).toMatchObject({ ok: false, error: 'webhook_url_refused' });
    const badKind = await c('POST', '/admin/webhooks', { cwd, url: 'http://localhost/h', kinds: ['x.y'] });
    expect(badKind.json).toMatchObject({ ok: false, error: 'webhook_kinds_invalid' });
    const noCwd = await c('POST', '/admin/webhooks', { url: 'http://localhost/h', kinds: ['human.message'] });
    expect(noCwd.status).toBe(400);

    const list = await c('GET', `/admin/webhooks?${new URLSearchParams({ cwd })}`);
    expect(list.status).toBe(200);
    expect(list.json.subscriptions.map((s) => s.id)).toEqual([ok.json.id]);
    expect(list.json.subscriptions[0].secret).toBeUndefined();
    expect((await c('GET', '/admin/webhooks?cwd=relative')).status).toBe(400);

    const del = await c('DELETE', `/admin/webhooks?${new URLSearchParams({ cwd, id: ok.json.id })}`);
    expect(del.json).toEqual({ ok: true, removed: true });
    const again = await c('DELETE', `/admin/webhooks?${new URLSearchParams({ cwd, id: ok.json.id })}`);
    expect(again.status).toBe(404);
  } finally {
    await admin.stop();
  }
});
