/**
 * voiceAdminRoutes.test.cjs — GET /admin/voices and POST /admin/voices/preview:
 * list, ready within the wait, queued with the lane position, a repeat call
 * joining the run / reading the cache, bad input -> 400, and no write route.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/voiceAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const { Readable } = require('node:stream');

const { registerAdminRoute, wavSeconds, _resetPending } = require('../voiceAdminRoutes.cjs');

const ROOT = '/tmp/proj';

function wav(seconds, rate = 8000) {
  const dataBytes = Math.round(seconds * rate * 2);
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(dataBytes, 40);
  return b;
}

function makeDeps(over = {}) {
  const calls = { preview: [], list: [] };
  const deps = {
    resolveCwd: (cwd) => (cwd === ROOT ? { ok: true, cwd: ROOT } : { ok: false, status: 400, error: 'cwd rejected' }),
    voiceLibrary: {
      listVoices: (root) => { calls.list.push(root); return { voices: [{ id: 'narrator', scope: 'builtin' }], errors: [{ file: 'x.json', error: 'bad' }] }; },
      resolveVoiceId: (_root, id) => (id === 'narrator' ? { ok: true } : { ok: false, error: `unknown voice '${id}'` }),
    },
    voiceLane: { laneSnapshot: () => ({ heavy: [{ voiceId: 'other', projectRoot: ROOT, position: 0 }, { voiceId: 'narrator', projectRoot: ROOT, position: 1 }], light: [] }) },
    previewVoice: async (args) => { calls.preview.push(args); return { ok: true, cached: false, wavPath: '/cache/k.wav', bytes: wav(1.5) }; },
    waitMs: 1000,
    ...over,
  };
  const routes = new Map();
  registerAdminRoute({ registerRoute: (m, u, h) => routes.set(`${m} ${u}`, h) }, deps);
  return { routes, calls };
}

function fakeRes() {
  const res = { status: 0, body: null };
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}

async function get(routes, query) {
  const res = fakeRes();
  await routes.get('GET /admin/voices')(Readable.from([]), res, new URLSearchParams(query));
  return res;
}

async function post(routes, body) {
  const res = fakeRes();
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  await routes.get('POST /admin/voices/preview')(Readable.from([Buffer.from(raw)]), res, new URLSearchParams());
  return res;
}

beforeEach(() => { _resetPending(); });

test('registers exactly the two read routes and no voice write route', () => {
  const { routes } = makeDeps();
  expect([...routes.keys()].sort()).toEqual(['GET /admin/voices', 'POST /admin/voices/preview']);
});

test('GET /admin/voices lists the project voices', async () => {
  const { routes, calls } = makeDeps();
  const res = await get(routes, { cwd: ROOT });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, voices: [{ id: 'narrator', scope: 'builtin' }], errors: [{ file: 'x.json', error: 'bad' }] });
  expect(calls.list).toEqual([ROOT]);
});

test('GET /admin/voices with a bad or missing cwd answers 400', async () => {
  const { routes } = makeDeps();
  expect((await get(routes, { cwd: '/elsewhere' })).status).toBe(400);
  expect((await get(routes, {})).status).toBe(400);
});

test('POST preview answers ready when previewVoice finishes within the wait', async () => {
  const { routes, calls } = makeDeps();
  const res = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: '  Hello there.  ' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ok: true, status: 'ready', cached: false, wavPath: '/cache/k.wav', audioSeconds: 1.5 });
  expect(Number.isFinite(res.body.wallMs)).toBe(true);
  expect(calls.preview).toEqual([{ projectRoot: ROOT, voiceId: 'narrator', text: 'Hello there.' }]);
});

test('POST preview answers queued with the lane position, and a repeat call joins the same run', async () => {
  let finish;
  const gate = new Promise((r) => { finish = r; });
  const { routes, calls } = makeDeps({
    waitMs: 40,
    previewVoice: async (args) => { calls.preview.push(args); await gate; return { ok: true, cached: false, wavPath: '/cache/k.wav', bytes: wav(2) }; },
  });
  const first = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ ok: true, status: 'queued', lane: 'heavy', position: 1 });

  const second = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  expect(second.body.status).toBe('queued');
  expect(calls.preview).toHaveLength(1); // joined, not restarted

  // A repeat call made while the run is still going joins it and answers ready when it ends.
  const pendingThird = post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  await new Promise((r) => setTimeout(r, 5)); // let the third call reach the wait before the run ends
  finish();
  const third = await pendingThird;
  expect(third.body).toMatchObject({ ok: true, status: 'ready', wavPath: '/cache/k.wav', audioSeconds: 2 });
  expect(calls.preview).toHaveLength(1);
});

test('a repeat call after the run finished reads the cache through previewVoice', async () => {
  let n = 0;
  const { routes, calls } = makeDeps({
    previewVoice: async (args) => { calls.preview.push(args); n += 1; return { ok: true, cached: n > 1, wavPath: '/cache/k.wav', bytes: wav(1) }; },
  });
  const a = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  const b = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  expect(a.body).toMatchObject({ status: 'ready', cached: false });
  expect(b.body).toMatchObject({ status: 'ready', cached: true, wavPath: '/cache/k.wav', audioSeconds: 1 });
});

test('queued position is null when the run has no lane ticket yet', async () => {
  const { routes } = makeDeps({
    waitMs: 5,
    voiceLane: { laneSnapshot: () => ({ heavy: [], light: [] }) },
    previewVoice: () => new Promise(() => {}),
  });
  const res = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  expect(res.body).toEqual({ ok: true, status: 'queued', lane: null, position: null });
});

test('bad input answers 400 before any preview runs', async () => {
  const { routes, calls } = makeDeps();
  const bad = [
    'not json',
    [],
    { cwd: ROOT, voiceId: 'Narrator', text: 'Hi.' },
    { cwd: ROOT, voiceId: '-x', text: 'Hi.' },
    { cwd: ROOT, voiceId: 'a'.repeat(65), text: 'Hi.' },
    { cwd: ROOT, text: 'Hi.' },
    { cwd: ROOT, voiceId: 'narrator', text: '   ' },
    { cwd: ROOT, voiceId: 'narrator', text: 'x'.repeat(301) },
    { cwd: ROOT, voiceId: 'narrator' },
    { cwd: '/elsewhere', voiceId: 'narrator', text: 'Hi.' },
    { voiceId: 'narrator', text: 'Hi.' },
    { cwd: ROOT, voiceId: 'ghost', text: 'Hi.' },
  ];
  for (const body of bad) {
    const res = await post(routes, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(res.body.ok).toBe(false);
  }
  expect(calls.preview).toEqual([]);
});

test('a failed preview answers 500 with its error and the next call starts a new run', async () => {
  let n = 0;
  const { routes } = makeDeps({ previewVoice: async () => { n += 1; return n === 1 ? { ok: false, error: 'speak CLI failed' } : { ok: true, cached: false, wavPath: '/c.wav', bytes: wav(1) }; } });
  const a = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  expect(a.status).toBe(500);
  expect(a.body).toEqual({ ok: false, error: 'speak CLI failed' });
  const b = await post(routes, { cwd: ROOT, voiceId: 'narrator', text: 'Hi.' });
  expect(b.body.status).toBe('ready');
});

test('wavSeconds reads PCM duration and rejects non-WAV bytes', () => {
  expect(wavSeconds(wav(0.5))).toBe(0.5);
  expect(wavSeconds(Buffer.from('nope'))).toBeNull();
});
