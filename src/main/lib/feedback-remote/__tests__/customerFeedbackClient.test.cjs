/**
 * customerFeedbackClient.test.cjs — validation, wire mapping, submit, store, status refresh.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/customerFeedbackClient.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cf = require('../customerFeedbackClient.cjs');

let dir;
let storeFile;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-client-'));
  storeFile = path.join(dir, 'customer-feedback.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function mkFetch(status, json) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (status === 'throw') throw new Error('offline');
    return { status, ok: status >= 200 && status < 300, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}
const deps = (fetchImpl, extra = {}) => ({ fetchImpl, storeFile, now: () => 1000, appVersion: '9.9.9', ...extra });

test('constants and base resolution', () => {
  expect(cf.FEEDBACK_SLUG).toBe('session-manager');
  expect(cf.TAGS).toEqual(['bug', 'feature', 'discussion']);
  expect(cf.MAX_TITLE).toBe(120);
  expect(cf.MAX_BODY).toBe(5000);
  const prev = process.env.SM_FEEDBACK_ENDPOINT;
  process.env.SM_FEEDBACK_ENDPOINT = 'http://x.test/';
  expect(cf.resolveFeedbackBase()).toBe('http://x.test');
  delete process.env.SM_FEEDBACK_ENDPOINT;
  expect(cf.resolveFeedbackBase()).toBe('https://bilko.run');
  if (prev !== undefined) process.env.SM_FEEDBACK_ENDPOINT = prev;
});

test('validateSubmission trims and rejects bad input', () => {
  expect(cf.validateSubmission({ title: '  hi ', body: ' yo ', tag: 'bug' })).toEqual({
    ok: true, value: { title: 'hi', body: 'yo', tag: 'bug', images: [] },
  });
  expect(cf.validateSubmission({ title: ' ', body: 'x', tag: 'bug' }).ok).toBe(false);
  expect(cf.validateSubmission({ title: 'x', body: '', tag: 'bug' }).ok).toBe(false);
  expect(cf.validateSubmission({ title: 'x'.repeat(121), body: 'x', tag: 'bug' }).ok).toBe(false);
  expect(cf.validateSubmission({ title: 'x', body: 'x'.repeat(5001), tag: 'bug' }).ok).toBe(false);
  const r = cf.validateSubmission({ title: 'x', body: 'x', tag: 'nope' });
  expect(r.ok).toBe(false);
  expect(typeof r.error).toBe('string');
});

test('wire type mapping', () => {
  expect(cf.toWireType('discussion')).toBe('feedback');
  expect(cf.toWireType('bug')).toBe('bug');
  expect(cf.toWireType('feature')).toBe('feature');
  expect(cf.fromWireType('feedback')).toBe('discussion');
  expect(cf.fromWireType('bug')).toBe('bug');
});

test('submit success posts the wire body and stores the item', async () => {
  const f = mkFetch(201, { id: 'fb1', receipt: 'rc1' });
  const r = await cf.submit({ title: 'T', body: 'B', tag: 'discussion' }, deps(f));
  expect(r.ok).toBe(true);
  expect(f.calls[0].url).toBe('https://bilko.run/api/projects/session-manager/feedback');
  const sent = JSON.parse(f.calls[0].init.body);
  expect(sent).toEqual({
    target: { kind: 'page', id: 'desktop-app', label: 'Session Manager desktop' },
    type: 'feedback', title: 'T', description: 'B',
    client: { app: 'session-manager', version: '9.9.9', platform: process.platform },
  });
  expect(f.calls[0].init.signal).toBeDefined();
  expect(r.item).toEqual({
    id: 'fb1', receipt: 'rc1', tag: 'discussion', title: 'T', body: 'B', submittedAt: 1000,
    status: 'open', statusNote: null, statusAt: null, seenStatusAt: null, imageCount: 0,
  });
  const items = await cf.list(deps(f));
  expect(items).toHaveLength(1);
  expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600);
});

test('submit stores null receipt when absent', async () => {
  const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug' }, deps(mkFetch(201, { id: 'a' })));
  expect(r.item.receipt).toBeNull();
});

test('submit 429, 500 and network failure write nothing', async () => {
  const r429 = await cf.submit({ title: 'T', body: 'B', tag: 'bug' }, deps(mkFetch(429, {})));
  expect(r429).toEqual({ ok: false, error: 'Too many submissions — try again in a minute.' });
  const r500 = await cf.submit({ title: 'T', body: 'B', tag: 'bug' }, deps(mkFetch(500, { error: 'boom' })));
  expect(r500).toEqual({ ok: false, error: 'boom' });
  const rn = await cf.submit({ title: 'T', body: 'B', tag: 'bug' }, deps(mkFetch('throw')));
  expect(rn.ok).toBe(false);
  expect(fs.existsSync(storeFile)).toBe(false);
});

test('submit rejects invalid input without fetching', async () => {
  const f = mkFetch(201, { id: 'x' });
  const r = await cf.submit({ title: '', body: 'B', tag: 'bug' }, deps(f));
  expect(r.ok).toBe(false);
  expect(f.calls).toHaveLength(0);
});

test('store caps at newest 500 and recovers from corrupt file', async () => {
  fs.writeFileSync(storeFile, '{not json');
  expect(await cf.list(deps(mkFetch(201, {})))).toEqual([]);
  const items = Array.from({ length: 500 }, (_, i) => ({
    id: `o${i}`, receipt: null, tag: 'bug', title: 't', body: 'b', submittedAt: i,
    status: 'open', statusNote: null, statusAt: null, seenStatusAt: null,
  }));
  fs.writeFileSync(storeFile, JSON.stringify({ schemaVersion: 1, items }));
  await cf.submit({ title: 'new', body: 'B', tag: 'bug' }, deps(mkFetch(201, { id: 'new' }), { now: () => 99999 }));
  const out = await cf.list(deps(mkFetch(201, {})));
  expect(out).toHaveLength(500);
  expect(out[0].id).toBe('new');
});

test('refreshStatuses updates matches; 404 is unsupported', async () => {
  await cf.submit({ title: 'T', body: 'B', tag: 'bug' }, deps(mkFetch(201, { id: 'fb1', receipt: 'rc1' })));
  await cf.submit({ title: 'N', body: 'B', tag: 'bug' }, deps(mkFetch(201, { id: 'fb2' })));
  const f = mkFetch(200, { items: [{ id: 'fb1', status: 'resolved', note: 'fixed', statusAt: 5000 }] });
  const r = await cf.refreshStatuses(deps(f));
  expect(r).toEqual({ ok: true, updated: 1 });
  expect(f.calls[0].url).toBe('https://bilko.run/api/projects/session-manager/feedback/status-lookup');
  expect(JSON.parse(f.calls[0].init.body)).toEqual({ items: [{ id: 'fb1', receipt: 'rc1' }] });
  const items = await cf.list(deps(f));
  const it = items.find((x) => x.id === 'fb1');
  expect(it.status).toBe('resolved');
  expect(it.statusNote).toBe('fixed');
  expect(it.statusAt).toBe(5000);

  const r404 = await cf.refreshStatuses(deps(mkFetch(404, {})));
  expect(r404).toEqual({ ok: true, updated: 0, unsupported: true });
  const rn = await cf.refreshStatuses(deps(mkFetch('throw')));
  expect(rn.ok).toBe(false);
});

test('markSeen and unseenCount', async () => {
  await cf.submit({ title: 'T', body: 'B', tag: 'bug' }, deps(mkFetch(201, { id: 'fb1', receipt: 'rc1' })));
  await cf.refreshStatuses(deps(mkFetch(200, { items: [{ id: 'fb1', status: 'resolved', note: null, statusAt: 7 }] })));
  expect(cf.unseenCount(await cf.list(deps(null)))).toBe(1);
  await cf.markSeen(['other'], deps(null));
  expect(cf.unseenCount(await cf.list(deps(null)))).toBe(1);
  await cf.markSeen(undefined, deps(null));
  expect(cf.unseenCount(await cf.list(deps(null)))).toBe(0);
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';
const IMGS = [{ dataUrl: PNG, mime: 'image/png' }, { dataUrl: JPG, mime: 'image/jpeg' }];

test('MAX_IMAGES is 5', () => {
  expect(cf.MAX_IMAGES).toBe(5);
});

test('submit sends images in the POST body and stores only imageCount', async () => {
  const f = mkFetch(201, { id: 'fbi', imageCount: 2 });
  const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug', images: IMGS }, deps(f));
  const sent = JSON.parse(f.calls[0].init.body);
  expect(sent.images).toEqual(IMGS);
  expect(r.ok).toBe(true);
  expect('warning' in r).toBe(false);
  expect(r.item.imageCount).toBe(2);
  const raw = fs.readFileSync(storeFile, 'utf8');
  expect(raw).not.toContain('data:image');
});

test('submit without images has no images key', async () => {
  const f = mkFetch(201, { id: 'fbn' });
  const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug', images: [] }, deps(f));
  expect('images' in JSON.parse(f.calls[0].init.body)).toBe(false);
  expect(r.ok).toBe(true);
  expect('warning' in r).toBe(false);
  expect(r.item.imageCount).toBe(0);
});

test('submit warns when the host omits imageCount or reports 0', async () => {
  const msg = 'Sent without the images — the feedback service does not accept images yet.';
  const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug', images: IMGS }, deps(mkFetch(201, { id: 'o1' })));
  expect(r).toMatchObject({ ok: true, warning: msg });
  expect(r.item.imageCount).toBe(0);
  const r0 = await cf.submit({ title: 'T', body: 'B', tag: 'bug', images: IMGS }, deps(mkFetch(201, { id: 'o2', imageCount: 0 })));
  expect(r0.warning).toBe(msg);
});

test('submit warns on a partial imageCount', async () => {
  const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug', images: IMGS }, deps(mkFetch(201, { id: 'p1', imageCount: 1 })));
  expect(r.ok).toBe(true);
  expect(r.warning).toBe('Only 1 of 2 images were accepted by the feedback service.');
  expect(r.item.imageCount).toBe(1);
});

test('invalid image entries are rejected without fetching', async () => {
  const bad = [
    [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', mime: 'image/svg+xml' }],
    [{ dataUrl: 'https://x.test/a.png', mime: 'image/png' }],
    [{ dataUrl: 'data:image/png;base64,' + 'A'.repeat(2000000), mime: 'image/png' }],
    [{ dataUrl: PNG }],
    'not-an-array',
    Array.from({ length: 6 }, () => ({ dataUrl: PNG, mime: 'image/png' })),
  ];
  for (const images of bad) {
    const f = mkFetch(201, { id: 'x' });
    const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug', images }, deps(f));
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(f.calls).toHaveLength(0);
  }
  expect(cf.validateSubmission({ title: 'T', body: 'B', tag: 'bug', images: IMGS }).ok).toBe(true);
});

const CONTEXT = {
  page: { url: 'https://x.test/a', title: 'A', viewport: { width: 800, height: 600, devicePixelRatio: 2, scrollX: 0, scrollY: 10 } },
  marks: [{ kind: 'pin', n: 1, x: 1, y: 2, color: '#a83818', note: 'here' }],
  console: [{ level: 'error', message: 'boom', timestamp: '2026-11-23T10:41:58.010Z', count: 2 }],
  network: [{ method: 'GET', url: 'https://x.test/api', status: 500, durationMs: 12, timestamp: '2026-11-23T10:41:58.010Z' }],
  client: { captureError: 'canvas tainted' },
};

test('submit sends a valid context unchanged in the POST body', async () => {
  const f = mkFetch(201, { id: 'fbc' });
  const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug', context: CONTEXT }, deps(f));
  expect(r.ok).toBe(true);
  expect(JSON.parse(f.calls[0].init.body).context).toEqual(CONTEXT);
  const f2 = mkFetch(201, { id: 'fbn' });
  await cf.submit({ title: 'T', body: 'B', tag: 'bug' }, deps(f2));
  expect('context' in JSON.parse(f2.calls[0].init.body)).toBe(false);
});

test('an oversize or invalid context is refused before any request', async () => {
  const big = { ...CONTEXT, marks: [{ kind: 'pin', n: 1, x: 1, y: 2, color: '#a83818', note: 'x'.repeat(900) }] };
  big.marks = Array.from({ length: 300 }, () => big.marks[0]);
  for (const context of [big, { ...CONTEXT, extra: 1 }, { console: [{ level: 'warn' }] }, 'str']) {
    const f = mkFetch(201, { id: 'x' });
    const r = await cf.submit({ title: 'T', body: 'B', tag: 'bug', context }, deps(f));
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(f.calls).toHaveLength(0);
  }
});

test('a 5000-char body is sent', async () => {
  const f = mkFetch(201, { id: 'fb5' });
  const body = 'b'.repeat(5000);
  const r = await cf.submit({ title: 'T', body, tag: 'bug' }, deps(f));
  expect(r.ok).toBe(true);
  expect(JSON.parse(f.calls[0].init.body).description).toBe(body);
});
