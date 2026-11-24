/**
 * feedbackEnvelope.test.cjs — open + validate one sealed feedback envelope: happy path and one
 * failing case per error code; no error ever carries report text, image bytes or key material.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/feedbackEnvelope.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const zlib = require('node:zlib');
const { generateBoxKeypair, sealEnvelope } = require('../feedbackSeal.cjs');
const { openReportEnvelope, ERROR_CODES } = require('../feedbackEnvelope.cjs');

const W = 4;
const H = 3;
const BOX_ID = 'box_test_1';
const SECRET_TITLE = 'Secret title zebra-7731';
const box = generateBoxKeypair();

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
/** Minimal RGB 8-bit PNG of w x h. @param {number} w @param {number} h @param {number} [shade] */
function makePng(w, h, shade = 0x80) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(h * (1 + w * 3), shade);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function validReport() {
  return {
    schemaVersion: 1,
    clientReportId: '6f1c2a9e-3b7d-4c55-9a0e-2f8d41b7c613',
    project: 'lumen',
    type: 'bug',
    title: SECRET_TITLE,
    details: 'Clicked Book twice.',
    createdAt: '2026-11-23T10:42:17.204Z',
    page: {
      url: 'https://example.test/stays',
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

/**
 * @param {Array<[string, string | Buffer, string?]>} fields name, value, optional file mime
 * @returns {Promise<{ body: Buffer, contentType: string }>}
 */
async function multipart(fields) {
  const fd = new FormData();
  for (const [name, value, mime] of fields) {
    if (typeof value === 'string' && !mime) fd.append(name, value);
    else fd.append(name, new Blob([value], { type: mime || 'application/octet-stream' }), `${name}.bin`);
  }
  const req = new Request('http://localhost/', { method: 'POST', body: fd });
  return {
    body: Buffer.from(await req.arrayBuffer()),
    contentType: String(req.headers.get('content-type')),
  };
}

/**
 * @param {{ report?: unknown, reportRaw?: string, screenshot?: Buffer, annotated?: Buffer,
 *   extra?: boolean, omit?: string }} [o]
 */
async function sealed(o = {}) {
  /** @type {Array<[string, string | Buffer, string?]>} */
  const fields = [
    ['report', o.reportRaw != null ? o.reportRaw : JSON.stringify(o.report || validReport()), 'application/json'],
    ['screenshot', o.screenshot || makePng(W, H), 'image/png'],
    ['annotated', o.annotated || makePng(W, H, 0x20), 'image/png'],
  ];
  if (o.extra) fields.push(['evil', 'x']);
  const kept = fields.filter(([n]) => n !== o.omit);
  const { body, contentType } = await multipart(kept);
  return sealEnvelope(body, contentType, box.publicKey, BOX_ID);
}

const opts = () => ({ privateKeyJwk: box.privateKeyJwk, boxId: BOX_ID });

/** Assert a failure carries only the code — no plaintext, image bytes or key material. */
function expectCleanFailure(/** @type {any} */ r, /** @type {string} */ code) {
  expect(r).toEqual({ ok: false, code });
  expect(ERROR_CODES).toContain(code);
  const s = JSON.stringify(r);
  expect(s).not.toContain(SECRET_TITLE);
  expect(s).not.toContain(String(box.privateKeyJwk.d));
  expect(s).not.toContain('IHDR');
  expect(s).not.toContain('PNG');
}

test('happy path: opens, parses and validates report + two PNGs', async () => {
  const shot = makePng(W, H);
  const ann = makePng(W, H, 0x20);
  const r = await openReportEnvelope(await sealed({ screenshot: shot, annotated: ann }), opts());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.report.title).toBe(SECRET_TITLE);
  expect(Buffer.isBuffer(r.screenshot)).toBe(true);
  expect(r.screenshot.equals(shot)).toBe(true);
  expect(r.annotated.equals(ann)).toBe(true);
});

test('dimensions within +-1 of report.screenshot are accepted', async () => {
  const r = await openReportEnvelope(await sealed({ screenshot: makePng(W + 1, H - 1) }), opts());
  expect(r.ok).toBe(true);
});

test('too_large: size check runs before decryption', async () => {
  // Garbage that would be bad_envelope if decrypted first.
  expectCleanFailure(await openReportEnvelope(Buffer.alloc(100, 1), { ...opts(), maxBytes: 50 }), 'too_large');
  const env = await sealed();
  expectCleanFailure(await openReportEnvelope(env, { ...opts(), maxBytes: env.length - 1 }), 'too_large');
});

test('bad_envelope: not an SMF1 envelope', async () => {
  expectCleanFailure(await openReportEnvelope(Buffer.from('not an envelope at all'), opts()), 'bad_envelope');
});

test('decrypt_failed: wrong box key, or wrong box id', async () => {
  const env = await sealed();
  const other = generateBoxKeypair();
  expectCleanFailure(await openReportEnvelope(env, { privateKeyJwk: other.privateKeyJwk, boxId: BOX_ID }), 'decrypt_failed');
  expectCleanFailure(await openReportEnvelope(env, { ...opts(), boxId: 'box_other' }), 'decrypt_failed');
});

test('bad_multipart: wrong content type, extra field, missing field, garbage body', async () => {
  const json = sealEnvelope(Buffer.from(JSON.stringify(validReport())), 'application/json', box.publicKey, BOX_ID);
  expectCleanFailure(await openReportEnvelope(json, opts()), 'bad_multipart');
  const noBoundary = sealEnvelope(Buffer.from('x'), 'multipart/form-data', box.publicKey, BOX_ID);
  expectCleanFailure(await openReportEnvelope(noBoundary, opts()), 'bad_multipart');
  expectCleanFailure(await openReportEnvelope(await sealed({ extra: true }), opts()), 'bad_multipart');
  expectCleanFailure(await openReportEnvelope(await sealed({ omit: 'annotated' }), opts()), 'bad_multipart');
  const garbage = sealEnvelope(Buffer.from(`${SECRET_TITLE} no parts here`), 'multipart/form-data; boundary=zzz', box.publicKey, BOX_ID);
  expectCleanFailure(await openReportEnvelope(garbage, opts()), 'bad_multipart');
});

test('bad_report: invalid JSON, or JSON failing the Report v1 schema', async () => {
  expectCleanFailure(await openReportEnvelope(await sealed({ reportRaw: `{${SECRET_TITLE}` }), opts()), 'bad_report');
  const bad = { ...validReport(), type: 'nope' };
  expectCleanFailure(await openReportEnvelope(await sealed({ report: bad }), opts()), 'bad_report');
});

test('bad_image: not a PNG, size mismatch, edge over 8192, over 8 MiB', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  expectCleanFailure(await openReportEnvelope(await sealed({ screenshot: jpeg }), opts()), 'bad_image');
  expectCleanFailure(await openReportEnvelope(await sealed({ annotated: makePng(W + 2, H) }), opts()), 'bad_image');
  const huge = makePng(8193, 1);
  const hugeReport = validReport();
  hugeReport.screenshot.width = 8193;
  hugeReport.screenshot.height = 1;
  expectCleanFailure(await openReportEnvelope(await sealed({ report: hugeReport, screenshot: huge, annotated: huge }), opts()), 'bad_image');
  const big = Buffer.concat([makePng(W, H), Buffer.alloc(8 * 1024 * 1024)]);
  expectCleanFailure(await openReportEnvelope(await sealed({ screenshot: big }), { ...opts(), maxBytes: 20 * 1024 * 1024 }), 'bad_image');
});
