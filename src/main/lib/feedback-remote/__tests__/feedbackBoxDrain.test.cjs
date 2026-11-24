/**
 * feedbackBoxDrain.test.cjs — the desktop drain against relayBoxesMock with a real keystore
 * (SM_SCHEDULER_HOME temp dir) and a real feedback-inbox (temp project cwd).
 *
 * A tiny forwarder strips the client's /api/sm-relay prefix and can inject a 500 / 429.
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/feedbackBoxDrain.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const config = require('../../../config.cjs');
const { startRelayBoxesMock } = require('./helpers/relayBoxesMock.cjs');
const { createRelayClient } = require('../feedbackRelayClient.cjs');
const { generateBoxKeypair, keyFingerprint, sealEnvelope } = require('../feedbackSeal.cjs');
const keystore = require('../feedbackBoxKeys.cjs');
const inbox = require('../siteFeedbackInbox.cjs');
const drainMod = require('../feedbackBoxDrain.cjs');

const TOKEN = 'dtok-SECRET-' + crypto.randomBytes(8).toString('hex');
const ORIGIN = 'https://site.test';
const SECRET_TITLE = 'Secret title zebra-7731';
const W = 4;
const H = 3;

/** @type {number[]} */
const CRC_TABLE = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE.push(c >>> 0);
}
/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** @param {number} shade */
function makePng(shade) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(H * (1 + W * 3), shade);
  for (let y = 0; y < H; y++) raw[y * (1 + W * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {string} clientReportId */
function report(clientReportId) {
  return {
    schemaVersion: 1,
    clientReportId,
    project: 'lumen',
    type: 'bug',
    title: SECRET_TITLE,
    details: 'Clicked Book twice.',
    createdAt: '2026-11-23T10:42:17.204Z',
    page: {
      url: 'https://site.test/stays',
      title: 'Stays',
      viewport: { width: W, height: H, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    },
    screenshot: { part: 'screenshot', annotatedPart: 'annotated', width: W, height: H, scale: 1 },
    marks: [{ kind: 'pin', n: 1, x: 1, y: 1, color: '#a83818', note: 'here' }],
    console: null,
    network: null,
    user: null,
    client: { widgetVersion: '0.1.0' },
  };
}

/** @param {string} clientReportId @param {string} publicKey @param {string} boxId */
async function sealedReport(clientReportId, publicKey, boxId) {
  const fd = new FormData();
  fd.append('report', new Blob([JSON.stringify(report(clientReportId))], { type: 'application/json' }), 'report.json');
  fd.append('screenshot', new Blob([makePng(0x80)], { type: 'image/png' }), 'screenshot.png');
  fd.append('annotated', new Blob([makePng(0x20)], { type: 'image/png' }), 'annotated.png');
  const req = new Request('http://localhost/', { method: 'POST', body: fd });
  const body = Buffer.from(await req.arrayBuffer());
  return sealEnvelope(body, String(req.headers.get('content-type')), publicKey, boxId);
}

/** @param {string} baseUrl @param {string} boxId @param {Buffer} body @param {string} reportId */
function submit(baseUrl, boxId, body, reportId) {
  const u = new URL(`${baseUrl}/boxes/${boxId}/envelopes`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: {
        Origin: ORIGIN, 'X-Sm-Envelope': '1', 'X-Sm-Report-Id': reportId,
        'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Prefix-stripping forwarder with a fault knob. */
async function startProxy(/** @type {string} */ target) {
  const t = new URL(target);
  const knobs = { fail: /** @type {null | { status: number, headers?: Record<string, string>, body: object }} */ (null) };
  const server = http.createServer((req, res) => {
    const p = String(req.url || '/').replace(/^\/api\/sm-relay/, '') || '/';
    if (knobs.fail && req.method === 'GET' && /\/envelopes(\?|$)/.test(p)) {
      res.writeHead(knobs.fail.status, { 'Content-Type': 'application/json', ...(knobs.fail.headers || {}) });
      res.end(JSON.stringify(knobs.fail.body));
      req.resume();
      return;
    }
    const up = http.request({ host: t.hostname, port: t.port, method: req.method, path: p, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    knobs,
    stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }),
  };
}

/** @type {any} */ let mock;
/** @type {any} */ let proxy;
/** @type {any} */ let relay;
/** @type {string} */ let home;
/** @type {string} */ let cwd;
/** @type {string|undefined} */ let prevHome;
/** @type {string[]} */ let logs;

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-drain-home-'));
  process.env.SM_SCHEDULER_HOME = home;
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-drain-proj-')));
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  config.addAllowedRoot(cwd);
  mock = await startRelayBoxesMock({ deviceToken: TOKEN });
  proxy = await startProxy(mock.baseUrl);
  relay = createRelayClient({ baseUrl: proxy.baseUrl, getDeviceToken: () => TOKEN });
  logs = [];
});

afterEach(async () => {
  await proxy.stop();
  await mock.stop();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.rm(cwd, { recursive: true, force: true });
});

/** Create a box on the relay and record it in the real keystore. */
async function newBox(projectCwd = cwd) {
  const kp = generateBoxKeypair();
  const r = await relay.createBox({ label: 'Site', publicKey: kp.publicKey, allowedOrigins: [ORIGIN] });
  expect(r.ok).toBe(true);
  await keystore.addBox({
    boxId: r.boxId, projectCwd, publicKey: kp.publicKey,
    fingerprint: keyFingerprint(kp.publicKey), privateKeyJwk: /** @type {any} */ (kp.privateKeyJwk),
  });
  return { boxId: r.boxId, ...kp };
}

function deps() {
  return { relay, keystore, inbox, log: (/** @type {string} */ m) => { logs.push(m); } };
}

function expectCleanLogs(/** @type {any} */ box) {
  const s = logs.join('\n');
  expect(s).not.toContain(TOKEN);
  expect(s).not.toContain(SECRET_TITLE);
  expect(s).not.toContain(String(box.privateKeyJwk.d));
}

const rejectedFile = () => path.join(cwd, 'session-manager-operations', 'feedback-inbox', 'rejected.jsonl');

test('lib-layout lists feedbackBoxDrain under feedback-remote', () => {
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../scripts/lib-layout.json'), 'utf8'));
  expect(layout.feedbackBoxDrain).toBe('feedback-remote');
});

test('stores two reports, dedupes a resend, rejects a corrupt envelope, acks all', async () => {
  const box = await newBox();
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  const envA = await sealedReport(idA, box.publicKey, box.boxId);
  expect((/** @type {any} */ (await submit(mock.baseUrl, box.boxId, envA, idA))).status).toBe(201);
  expect((/** @type {any} */ (await submit(mock.baseUrl, box.boxId, await sealedReport(idB, box.publicKey, box.boxId), idB))).status).toBe(201);

  const d = drainMod.createDrain();
  const first = await d.drainOnce(deps());
  expect(first).toEqual({ stored: 2, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] });
  expect(mock.state.envelopes.get(box.boxId)).toHaveLength(0);
  const items = await inbox.list(cwd);
  expect(items).toHaveLength(2);
  expect(items.every((i) => i.boxId === box.boxId && i.origin === ORIGIN && /^FB-/.test(i.hostId))).toBe(true);

  // A resend of report A under a fresh host id (e.g. the host lost its dedupe map), plus a corrupt one.
  const envs = mock.state.envelopes.get(box.boxId);
  envs.push({ envelopeId: crypto.randomUUID(), hostId: 'FB-RSEND', clientReportId: idA,
    receivedAt: new Date().toISOString(), origin: ORIGIN, bytes: envA.length, body: envA });
  const corrupt = Buffer.concat([Buffer.from('SMF1'), crypto.randomBytes(64)]);
  envs.push({ envelopeId: crypto.randomUUID(), hostId: 'FB-CRPT1', clientReportId: crypto.randomUUID(),
    receivedAt: new Date().toISOString(), origin: ORIGIN, bytes: corrupt.length, body: corrupt });

  const second = await d.drainOnce(deps());
  expect(second).toEqual({ stored: 0, duplicates: 1, rejected: 1, goneBoxes: [], heldBoxes: [] });
  expect(mock.state.envelopes.get(box.boxId)).toHaveLength(0);
  expect(await inbox.list(cwd)).toHaveLength(2);

  const lines = fs.readFileSync(rejectedFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(Object.keys(lines[0]).sort()).toEqual(['at', 'boxId', 'bytes', 'code', 'hostId']);
  expect(lines[0]).toMatchObject({ boxId: box.boxId, hostId: 'FB-CRPT1', code: 'bad_envelope', bytes: corrupt.length });
  expectCleanLogs(box);
});

test('drainOnce is single-flight', async () => {
  await newBox();
  const d = drainMod.createDrain();
  const a = d.drainOnce(deps());
  const b = d.drainOnce(deps());
  expect(a).toBe(b);
  await a;
  expect(d.drainOnce(deps())).not.toBe(a);
});

test('a deleted box is reported gone and skipped until its keystore record is removed', async () => {
  const box = await newBox();
  expect((await relay.deleteBox(box.boxId)).ok).toBe(true);
  const d = drainMod.createDrain();
  expect((await d.drainOnce(deps())).goneBoxes).toEqual([box.boxId]);
  const before = mock.state.requests.length;
  expect((await d.drainOnce(deps())).goneBoxes).toEqual([box.boxId]);
  expect(mock.state.requests.length).toBe(before);
  await keystore.removeBox(box.boxId);
  expect((await d.drainOnce(deps())).goneBoxes).toEqual([]);
  expectCleanLogs(box);
});

test('a box whose projectCwd is missing is held, not drained or acked', async () => {
  const missing = path.join(os.tmpdir(), `fb-drain-gone-${crypto.randomUUID()}`);
  const box = await newBox(missing);
  const id = crypto.randomUUID();
  await submit(mock.baseUrl, box.boxId, await sealedReport(id, box.publicKey, box.boxId), id);
  const r = await drainMod.createDrain().drainOnce(deps());
  expect(r).toEqual({ stored: 0, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [box.boxId] });
  expect(mock.state.envelopes.get(box.boxId)).toHaveLength(1);
});

test('a 500 stops the box without acking; the next pass resumes', async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  await submit(mock.baseUrl, box.boxId, await sealedReport(id, box.publicKey, box.boxId), id);
  const d = drainMod.createDrain();
  proxy.knobs.fail = { status: 500, body: { error: 'internal' } };
  expect(await d.drainOnce(deps())).toEqual({ stored: 0, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] });
  expect(mock.state.envelopes.get(box.boxId)).toHaveLength(1);
  proxy.knobs.fail = null;
  expect((await d.drainOnce(deps())).stored).toBe(1);
  expect(mock.state.envelopes.get(box.boxId)).toHaveLength(0);
  expectCleanLogs(box);
});

test('a 429 defers the box by Retry-After', async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  await submit(mock.baseUrl, box.boxId, await sealedReport(id, box.publicKey, box.boxId), id);
  let t = 1_000_000;
  const d = drainMod.createDrain({ now: () => t });
  proxy.knobs.fail = { status: 429, headers: { 'Retry-After': '30' }, body: { error: 'rate_limited' } };
  expect((await d.drainOnce(deps())).stored).toBe(0);
  proxy.knobs.fail = null;
  const before = mock.state.requests.length;
  t += 10_000;
  expect((await d.drainOnce(deps())).stored).toBe(0);
  expect(mock.state.requests.length).toBe(before);
  t += 25_000;
  expect((await d.drainOnce(deps())).stored).toBe(1);
});

test('startDrainLoop exposes drainNow and runs on an unref\'d timer', async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  await submit(mock.baseUrl, box.boxId, await sealedReport(id, box.publicKey, box.boxId), id);
  const loop = drainMod.createDrain().startDrainLoop({ intervalMs: 3_600_000, ...deps() });
  try {
    expect((await loop.drainNow()).stored).toBe(1);
  } finally {
    loop.stop();
  }
  expect(typeof drainMod.drainOnce).toBe('function');
  expect(typeof drainMod.startDrainLoop).toBe('function');
});

test('a box whose project root nothing registered is stored and acked', async () => {
  const base = path.join(os.homedir(), '.cache');
  fs.mkdirSync(base, { recursive: true });
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(base, 'fb-drain-unreg-')));
  try {
    expect(config.getAllowedRoots()).not.toContain(fresh);
    const box = await newBox(fresh);
    const id = crypto.randomUUID();
    await submit(mock.baseUrl, box.boxId, await sealedReport(id, box.publicKey, box.boxId), id);
    const r = await drainMod.createDrain().drainOnce(deps());
    expect(logs).toEqual([]);
    expect(r).toEqual({ stored: 1, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] });
    expect(mock.state.envelopes.get(box.boxId)).toHaveLength(0);
    expect(await inbox.list(fresh)).toHaveLength(1);
    expectCleanLogs(box);
  } finally {
    await fsp.rm(fresh, { recursive: true, force: true });
  }
});

test('a write failure logs a classified safe code, not the bare error name', async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  await submit(mock.baseUrl, box.boxId, await sealedReport(id, box.publicKey, box.boxId), id);
  const denying = { ...inbox, writeItem: async () => { throw new Error(`Write outside allowed write boundaries: ${SECRET_TITLE}`); } };
  const r = await drainMod.createDrain().drainOnce({ ...deps(), inbox: denying });
  expect(r.stored).toBe(0);
  expect(mock.state.envelopes.get(box.boxId)).toHaveLength(1);
  expect(logs).toEqual([`box ${box.boxId} stopped for this pass (write_denied)`]);
  const ioErr = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  logs = [];
  await drainMod.createDrain().drainOnce({ ...deps(), inbox: { ...inbox, writeItem: async () => { throw ioErr; } } });
  expect(logs).toEqual([`box ${box.boxId} stopped for this pass (io_error)`]);
  expectCleanLogs(box);
});
