/**
 * customerFeedbackInbox.test.cjs — owner config, incremental pull, status, epic link.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/customerFeedbackInbox.test.cjs
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

// ── images: metadata + local cache ──────────────────────────────────────────
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pngdata')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpgdata')]);
const GIF = Buffer.from('GIF89a-gifdata');
const durl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
const meta = (mime, buf) => ({ dataUrl: null, mime, bytes: durl(mime, buf).length });
const full = (mime, buf) => ({ dataUrl: durl(mime, buf), mime, bytes: durl(mime, buf).length });

/** Page GET (images=none) returns `pageItems`; targeted GET returns `imageItems` or `imageResp`. */
function imgFetch(pageItems, imageItems, imageResp) {
  return mkFetch((url) => {
    if (url.includes('images=none')) return { status: 200, json: { items: pageItems, nextSince: 'S', nextModeratedSince: null } };
    if (imageResp) return imageResp;
    return { status: 200, json: { items: imageItems, nextSince: null, nextModeratedSince: null } };
  });
}
const imgDeps = (f) => deps(f, { imagesDir: path.join(dir, 'imgs') });

test('maps image metadata in order, caps at 5, absent = []', async () => {
  const six = Array.from({ length: 6 }, () => meta('image/png', PNG));
  const f = imgFetch([wire('m1', { images: six }), wire('m2'), wire('m3', { images: 'nope' })], [], { status: 500, json: {} });
  const r = await inbox.pull(imgDeps(f));
  expect(r.ok).toBe(true);
  const items = (await inbox.list({}, imgDeps(f))).items;
  const m1 = items.find((i) => i.id === 'm1');
  expect(m1.images).toHaveLength(5);
  expect(m1.images[0]).toEqual({ mime: 'image/png', bytes: six[0].bytes, path: null });
  expect(items.find((i) => i.id === 'm2').images).toEqual([]);
  expect(items.find((i) => i.id === 'm3').images).toEqual([]);
});

test('caches a 3-image item in order with extensions and 0o600; one targeted GET', async () => {
  const imgs = [meta('image/png', PNG), meta('image/jpeg', JPG), meta('image/gif', GIF)];
  const fulls = [full('image/png', PNG), full('image/jpeg', JPG), full('image/gif', GIF)];
  const f = imgFetch([wire('c1', { images: imgs })], [wire('c0'), wire('c1', { images: fulls })]);
  const r = await inbox.pull(imgDeps(f));
  expect(r).toEqual({ ok: true, fetched: 1, pages: 1, imagesCached: 3 });
  expect(f.calls).toHaveLength(2);
  const u = new URL(f.calls[1].url);
  expect(u.searchParams.get('since')).toBe('2026-01-01T00:00:00.000Z');
  expect(u.searchParams.get('limit')).toBe('1');
  expect(u.searchParams.has('images')).toBe(false);
  expect(f.calls[1].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  const d = path.join(dir, 'imgs', 'c1');
  expect(fs.readdirSync(d).sort()).toEqual(['1.png', '2.jpg', '3.gif']);
  expect(fs.readFileSync(path.join(d, '2.jpg')).equals(JPG)).toBe(true);
  for (const n of fs.readdirSync(d)) expect(fs.statSync(path.join(d, n)).mode & 0o777).toBe(0o600);
  const item = (await inbox.list({}, imgDeps(f))).items[0];
  expect(item.images.map((i) => i.path)).toEqual([path.join(d, '1.png'), path.join(d, '2.jpg'), path.join(d, '3.gif')]);
  expect(fs.readFileSync(storeFile, 'utf8')).not.toContain('base64');

  // second pull: already cached → no targeted GET, paths kept
  const f2 = imgFetch([wire('c1', { images: imgs })], []);
  const r2 = await inbox.pull(imgDeps(f2));
  expect(r2.imagesCached).toBe(0);
  expect(f2.calls).toHaveLength(1);
  expect((await inbox.list({}, imgDeps(f2))).items[0].images[2].path).toBe(path.join(d, '3.gif'));

  const ok = await inbox.readCachedImage('c1', 1, imgDeps(f2));
  expect(ok).toEqual({ ok: true, dataUrl: durl('image/jpeg', JPG) });
});

/** Image GETs answered by `byLimit[limit]` (wire items); page GET returns `pageItems`. */
function limitFetch(pageItems, byLimit) {
  return mkFetch((url) => {
    if (url.includes('images=none')) return { status: 200, json: { items: pageItems, nextSince: 'S', nextModeratedSince: null } };
    const limit = new URL(url).searchParams.get('limit');
    return { status: 200, json: { items: byLimit[limit] || [], nextSince: null, nextModeratedSince: null } };
  });
}
const imageLimits = (f) => f.calls.filter((c) => !c.url.includes('images=none'))
  .map((c) => new URL(c.url).searchParams.get('limit'));

test('same-second miss on limit=1 retries once with limit=20 and caches', async () => {
  const f = limitFetch([wire('s2', { images: [meta('image/png', PNG)] })], {
    1: [wire('s1')],
    20: [wire('s1'), wire('s2', { images: [full('image/png', PNG)] })],
  });
  const r = await inbox.pull(imgDeps(f));
  expect(r).toEqual({ ok: true, fetched: 1, pages: 1, imagesCached: 1 });
  expect(imageLimits(f)).toEqual(['1', '20']);
  for (const c of f.calls.slice(1)) {
    const u = new URL(c.url);
    expect(u.searchParams.get('since')).toBe('2026-01-01T00:00:01.000Z');
    expect(u.searchParams.has('images')).toBe(false);
    expect(c.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  }
  expect(fs.existsSync(path.join(dir, 'imgs', 's2', '1.png'))).toBe(true);
});

test('one response holding two uncached items caches both with one image GET', async () => {
  const f = limitFetch([wire('d1', { images: [meta('image/png', PNG)] }), wire('d2', { images: [meta('image/gif', GIF)] })], {
    1: [wire('d1', { images: [full('image/png', PNG)] }), wire('d2', { images: [full('image/gif', GIF)] })],
  });
  const r = await inbox.pull(imgDeps(f));
  expect(r).toEqual({ ok: true, fetched: 2, pages: 1, imagesCached: 2 });
  expect(imageLimits(f)).toEqual(['1']);
  const items = (await inbox.list({}, imgDeps(f))).items;
  expect(items.find((i) => i.id === 'd1').images[0].path).toBe(path.join(dir, 'imgs', 'd1', '1.png'));
  expect(items.find((i) => i.id === 'd2').images[0].path).toBe(path.join(dir, 'imgs', 'd2', '1.gif'));
});

test('both image GETs miss: paths stay null, pull ok', async () => {
  const f = limitFetch([wire('n1', { images: [meta('image/png', PNG)] })], { 1: [wire('n0')], 20: [wire('n0')] });
  const r = await inbox.pull(imgDeps(f));
  expect(r).toEqual({ ok: true, fetched: 1, pages: 1, imagesCached: 0 });
  expect(imageLimits(f)).toEqual(['1', '20']);
  expect((await inbox.list({}, imgDeps(f))).items[0].images[0].path).toBeNull();
  expect(fs.existsSync(path.join(dir, 'imgs', 'n1'))).toBe(false);
});

test('mime-mismatch / malformed entries stay null with no file', async () => {
  const imgs = [meta('image/png', PNG), meta('image/png', PNG), meta('image/png', PNG)];
  const bad = [
    { dataUrl: durl('image/png', JPG), mime: 'image/png' }, // sniff mismatch
    { dataUrl: 'data:image/png;base64,@@@@', mime: 'image/png' }, // non-base64
    full('image/png', PNG),
  ];
  const f = imgFetch([wire('b1', { images: imgs })], [wire('b1', { images: bad })]);
  const r = await inbox.pull(imgDeps(f));
  expect(r.ok).toBe(true);
  expect(r.imagesCached).toBe(1);
  const d = path.join(dir, 'imgs', 'b1');
  expect(fs.readdirSync(d)).toEqual(['3.png']);
  const item = (await inbox.list({}, imgDeps(f))).items[0];
  expect(item.images.map((i) => i.path)).toEqual([null, null, path.join(d, '3.png')]);
});

test('failing image GET keeps pull ok, no token leak, retried next pull', async () => {
  const imgs = [meta('image/png', PNG)];
  const f = mkFetch((url) => (url.includes('images=none')
    ? { status: 200, json: { items: [wire('r1', { images: imgs })], nextSince: 'S', nextModeratedSince: null } }
    : 'throw'));
  const r = await inbox.pull(imgDeps(f));
  expect(r).toEqual({ ok: true, fetched: 1, pages: 1, imagesCached: 0 });
  expect(JSON.parse(fs.readFileSync(storeFile, 'utf8')).nextSince).toBe('S');
  expect((await inbox.list({}, imgDeps(f))).items[0].images[0].path).toBeNull();
  expect(fs.readFileSync(storeFile, 'utf8')).not.toContain(TOKEN);

  const f404 = imgFetch([], [], { status: 404, json: {} });
  expect((await inbox.pull(imgDeps(f404))).imagesCached).toBe(0);

  const f2 = mkFetch((url) => (url.includes('images=none')
    ? { status: 200, json: { items: [], nextSince: 'S', nextModeratedSince: null } }
    : { status: 200, json: { items: [wire('r1', { images: [full('image/png', PNG)] })] } }));
  const r2 = await inbox.pull(imgDeps(f2));
  expect(r2.imagesCached).toBe(1);
  expect(fs.existsSync(path.join(dir, 'imgs', 'r1', '1.png'))).toBe(true);
});

test('unsafe id is never used in a path', async () => {
  const imgs = [meta('image/png', PNG)];
  const evil = '../escape';
  const f = imgFetch([wire('x1', { id: evil, images: imgs })], [wire('x1', { id: evil, images: [full('image/png', PNG)] })]);
  const r = await inbox.pull(imgDeps(f));
  expect(r.ok).toBe(true);
  expect(r.imagesCached).toBe(0);
  expect(f.calls).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, 'escape'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'imgs'))).toBe(false);
  expect((await inbox.readCachedImage(evil, 0, imgDeps(f))).ok).toBe(false);
});

test('prunes cache dirs whose id left the mirror', async () => {
  const imgsDir = path.join(dir, 'imgs');
  fs.mkdirSync(path.join(imgsDir, 'gone1'), { recursive: true });
  fs.writeFileSync(path.join(imgsDir, 'gone1', '1.png'), PNG);
  const f = imgFetch([wire('k1', { images: [meta('image/png', PNG)] })], [wire('k1', { images: [full('image/png', PNG)] })]);
  await inbox.pull(imgDeps(f));
  expect(fs.readdirSync(imgsDir)).toEqual(['k1']);
});

test('readCachedImage refusals: bad index, unsafe id, missing file, no owner', async () => {
  const f = imgFetch([wire('z1', { images: [meta('image/png', PNG)] })], [wire('z1', { images: [full('image/png', PNG)] })]);
  await inbox.pull(imgDeps(f));
  const d = imgDeps(f);
  expect((await inbox.readCachedImage('z1', 0, d))).toEqual({ ok: true, dataUrl: durl('image/png', PNG) });
  for (const idx of [-1, 5, 1.5, '0', 1]) expect((await inbox.readCachedImage('z1', idx, d)).ok).toBe(false);
  expect((await inbox.readCachedImage('a/b', 0, d)).ok).toBe(false);
  expect((await inbox.readCachedImage('nope', 0, d)).ok).toBe(false);
  fs.writeFileSync(path.join(dir, 'imgs', 'z1', '1.png'), 'not an image');
  expect((await inbox.readCachedImage('z1', 0, d)).ok).toBe(false);
  fs.rmSync(path.join(dir, 'imgs', 'z1', '1.png'));
  expect((await inbox.readCachedImage('z1', 0, d)).ok).toBe(false);
  expect(await inbox.readCachedImage('z1', 0, { ...d, env: {} })).toEqual({ ok: false, error: 'Feedback owner token not configured' });
});
