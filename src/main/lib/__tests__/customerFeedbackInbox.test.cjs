/**
 * customerFeedbackInbox.test.cjs — owner config, incremental pull, status, epic link.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/customerFeedbackInbox.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inbox = require('../customerFeedbackInbox.cjs');

const TOKEN = 'sekrit-owner-token-123';
let dir;
let storeFile;
let ownerFile;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-inbox-'));
  storeFile = path.join(dir, 'inbox.json');
  ownerFile = path.join(dir, 'owner.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function mkFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = typeof responses === 'function' ? responses(url, init, calls.length) : responses;
    if (r === 'throw') throw new Error(`offline ${init.headers.authorization}`);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  };
  fn.calls = calls;
  return fn;
}
const env = { SM_FEEDBACK_OWNER_TOKEN: TOKEN };
const deps = (fetchImpl, extra = {}) => ({ fetchImpl, storeFile, ownerFile, env, now: () => 5000, ...extra });
const wire = (id, extra = {}) => ({
  id, receivedAt: `2026-01-01T00:00:0${id.slice(-1)}Z`, type: 'feedback', title: `t${id}`, description: `d${id}`,
  client: { version: '1.2.3', platform: 'linux' }, moderation: null, ...extra,
});

test('STATUSES', () => {
  expect(inbox.STATUSES).toEqual(['open', 'in_progress', 'resolved', 'wontfix']);
});

test('owner config precedence: env over file, null when neither', () => {
  expect(inbox.loadOwnerConfig({ ownerFile, env: {} })).toBeNull();
  fs.writeFileSync(ownerFile, JSON.stringify({ token: 'file-tok', projectCwd: '/p/file' }));
  expect(inbox.loadOwnerConfig({ ownerFile, env: {} })).toEqual({ token: 'file-tok', projectCwd: '/p/file' });
  expect(inbox.loadOwnerConfig({
    ownerFile, env: { SM_FEEDBACK_OWNER_TOKEN: 'env-tok', SM_FEEDBACK_OWNER_PROJECT_CWD: '/p/env' },
  })).toEqual({ token: 'env-tok', projectCwd: '/p/env' });
});

test('getOwnerInfo hides the token', () => {
  expect(inbox.getOwnerInfo({ ownerFile, env: {} })).toEqual({ ownerMode: false, projectCwd: null });
  const info = inbox.getOwnerInfo({ ownerFile, env: { ...env, SM_FEEDBACK_OWNER_PROJECT_CWD: '/p' } });
  expect(info).toEqual({ ownerMode: true, projectCwd: '/p' });
  expect(JSON.stringify(info)).not.toContain(TOKEN);
});

test('every owner function errors without a token', async () => {
  const d = { ownerFile, storeFile, env: {}, fetchImpl: mkFetch({ status: 200, json: {} }) };
  const err = { ok: false, error: 'Feedback owner token not configured' };
  expect(await inbox.pull(d)).toEqual(err);
  expect(await inbox.list({}, d)).toEqual(err);
  expect(await inbox.setStatus('a', 'open', undefined, d)).toEqual(err);
  expect(await inbox.linkEpic('a', 'e', d)).toEqual(err);
  expect(d.fetchImpl.calls.length).toBe(0);
});

test('multi-page pull persists cursors, preserves epicId, filters hidden', async () => {
  const page1 = Array.from({ length: 500 }, (_, i) => wire(`p${String(i).padStart(3, '0')}`));
  page1[0] = wire('a1', { receivedAt: '2026-01-01T00:00:01Z' });
  const f1 = mkFetch((url, init, n) => (n === 1
    ? { status: 200, json: { items: page1, nextSince: 's1', nextModeratedSince: 'm1' } }
    : { status: 200, json: { items: [wire('b2', { receivedAt: '2026-02-01T00:00:00Z', moderation: { action: 'archived' }, status: { value: 'resolved', note: 'done', at: 'T' } })], nextSince: 's2', nextModeratedSince: 'm2' } }));
  const r1 = await inbox.pull(deps(f1));
  expect(r1.ok).toBe(true);
  expect(f1.calls.length).toBe(2);
  expect(f1.calls[0].url).toContain('/api/projects/session-manager/feedback?');
  expect(f1.calls[0].url).toContain('images=none');
  expect(f1.calls[0].url).toContain('limit=500');
  expect(f1.calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  expect(f1.calls[1].url).toContain('since=s1');
  expect(f1.calls[1].url).toContain('moderatedSince=m1');

  const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  expect(stored.nextSince).toBe('s2');
  expect(stored.nextModeratedSince).toBe('m2');
  expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600);

  const visible = await inbox.list({}, deps(f1));
  expect(visible.ok).toBe(true);
  expect(visible.items.find((i) => i.id === 'b2')).toBeUndefined();
  const all = await inbox.list({ includeHidden: true }, deps(f1));
  expect(all.items[0].id).toBe('b2');
  expect(all.items[0]).toMatchObject({
    tag: 'discussion', title: 'tb2', body: 'db2', clientVersion: '1.2.3', clientPlatform: 'linux',
    moderation: 'archived', status: 'resolved', statusNote: 'done', statusAt: 'T', epicId: null,
  });
  expect(visible.items.find((i) => i.id === 'a1').status).toBe('open');

  expect((await inbox.linkEpic('a1', 'epic-9', deps(f1))).ok).toBe(true);
  const f2 = mkFetch({ status: 200, json: { items: [wire('a1', { title: 'renamed' })], nextSince: null, nextModeratedSince: null } });
  await inbox.pull(deps(f2));
  expect(f2.calls[0].url).toContain('since=s2');
  const after = (await inbox.list({}, deps(f2))).items.find((i) => i.id === 'a1');
  expect(after.title).toBe('renamed');
  expect(after.epicId).toBe('epic-9');
});

test('setStatus success, validation, 404, 401, network, no token leak', async () => {
  await inbox.pull(deps(mkFetch({ status: 200, json: { items: [wire('x1')], nextSince: null, nextModeratedSince: null } })));
  const ok = mkFetch({ status: 200, json: { id: 'x1', status: 'resolved', note: 'fixed', statusAt: 'T2' } });
  const r = await inbox.setStatus('x1', 'resolved', 'fixed', deps(ok));
  expect(r.ok).toBe(true);
  expect(ok.calls[0].url).toContain('/api/projects/session-manager/feedback/x1/status');
  expect(ok.calls[0].init.method).toBe('POST');
  expect(JSON.parse(ok.calls[0].init.body)).toEqual({ status: 'resolved', note: 'fixed' });
  const item = (await inbox.list({}, deps(ok))).items[0];
  expect(item).toMatchObject({ status: 'resolved', statusNote: 'fixed' });

  expect((await inbox.setStatus('x1', 'bogus', undefined, deps(ok))).ok).toBe(false);
  expect((await inbox.setStatus('x1', 'open', 'n'.repeat(501), deps(ok))).ok).toBe(false);
  expect(ok.calls.length).toBe(1);

  const nf = await inbox.setStatus('x1', 'open', undefined, deps(mkFetch({ status: 404, json: {} })));
  expect(nf).toEqual({ ok: false, error: 'Host does not support feedback status yet (or unknown id)' });
  const un = await inbox.setStatus('x1', 'open', undefined, deps(mkFetch({ status: 401, json: {} })));
  expect(un.ok).toBe(false);
  const net = await inbox.setStatus('x1', 'open', undefined, deps(mkFetch('throw')));
  expect(net.ok).toBe(false);
  for (const res of [nf, un, net]) expect(JSON.stringify(res)).not.toContain(TOKEN);
  expect(fs.readFileSync(storeFile, 'utf8')).not.toContain(TOKEN);
});

test('linkEpic links known id and rejects unknown', async () => {
  await inbox.pull(deps(mkFetch({ status: 200, json: { items: [wire('x1')], nextSince: null, nextModeratedSince: null } })));
  expect((await inbox.linkEpic('x1', 'e1', deps(null))).ok).toBe(true);
  expect((await inbox.list({}, deps(null))).items[0].epicId).toBe('e1');
  expect((await inbox.linkEpic('nope', 'e1', deps(null))).ok).toBe(false);
});
