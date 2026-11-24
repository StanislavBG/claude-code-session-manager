// @ts-check
/**
 * feedbackEnvelope — the one function the desktop drain calls per downloaded envelope.
 *
 * openReportEnvelope(buf, { privateKeyJwk, boxId, maxBytes }) enforces the size cap, opens the
 * sealed envelope (feedbackSeal.cjs), parses the handoff's multipart/form-data body, then
 * validates the Report v1 (feedbackReport.cjs) and both PNG images.
 *
 * Everything inside the envelope is attacker-controlled. The function never throws and every
 * failure is `{ ok: false, code }` with a fixed code — never report text, image bytes or key
 * material.
 */
'use strict';

const { openEnvelope } = require('./feedbackSeal.cjs');
const { parseReport } = require('./feedbackReport.cjs');
const { sniffImageMime } = require('../epic/epicAttachments.cjs');

const MAX_ENVELOPE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8192;
const DIMENSION_SLACK = 1;
const FIELD_NAMES = Object.freeze(['report', 'screenshot', 'annotated']);
const ERROR_CODES = Object.freeze([
  'too_large', 'bad_envelope', 'decrypt_failed', 'bad_multipart', 'bad_report', 'bad_image',
]);

/**
 * @typedef {'too_large' | 'bad_envelope' | 'decrypt_failed' | 'bad_multipart' | 'bad_report' | 'bad_image'} EnvelopeErrorCode
 * @typedef {import('./feedbackReport.cjs').Report} Report
 * @typedef {{ ok: true, report: Report, screenshot: Buffer, annotated: Buffer }
 *   | { ok: false, code: EnvelopeErrorCode }} OpenResult
 */

/**
 * @param {EnvelopeErrorCode} code
 * @returns {{ ok: false, code: EnvelopeErrorCode }}
 */
function failed(code) {
  return { ok: false, code };
}

/**
 * multipart/form-data with a non-empty boundary parameter.
 * @param {string} contentType
 */
function isMultipartWithBoundary(contentType) {
  const parts = contentType.split(';').map((s) => s.trim());
  if ((parts[0] || '').toLowerCase() !== 'multipart/form-data') return false;
  return parts.slice(1).some((p) => {
    const eq = p.indexOf('=');
    if (eq < 0) return false;
    const name = p.slice(0, eq).trim().toLowerCase();
    const value = p.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    return name === 'boundary' && value.length > 0;
  });
}

/**
 * PNG IHDR width/height (bytes 16-23, big-endian), or null when the chunk is not where it must be.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * @param {Buffer} buf
 * @param {{ width: number, height: number }} expected
 */
function imageOk(buf, expected) {
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return false;
  if (sniffImageMime(buf) !== 'image/png') return false;
  const size = pngSize(buf);
  if (!size) return false;
  if (size.width < 1 || size.height < 1) return false;
  if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) return false;
  return Math.abs(size.width - expected.width) <= DIMENSION_SLACK
    && Math.abs(size.height - expected.height) <= DIMENSION_SLACK;
}

/**
 * Open, parse and validate one downloaded feedback envelope. Never throws.
 * @param {Buffer|Uint8Array} buf
 * @param {{ privateKeyJwk: import('node:crypto').JsonWebKey, boxId: string, maxBytes?: number }} opts
 * @returns {Promise<OpenResult>}
 */
async function openReportEnvelope(buf, opts) {
  if (!opts || typeof opts !== 'object') return failed('decrypt_failed');
  const { privateKeyJwk, boxId, maxBytes = MAX_ENVELOPE_BYTES } = opts;
  if (!buf || typeof buf.length !== 'number') return failed('bad_envelope');
  if (buf.length > maxBytes) return failed('too_large');

  /** @type {{ contentType: string, body: Buffer }} */
  let opened;
  try {
    opened = openEnvelope(buf, privateKeyJwk, boxId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    return failed(msg === 'bad_envelope' ? 'bad_envelope' : 'decrypt_failed');
  }

  if (!isMultipartWithBoundary(opened.contentType)) return failed('bad_multipart');

  /** @type {FormData} */
  let form;
  try {
    form = await new Response(opened.body, { headers: { 'content-type': opened.contentType } }).formData();
  } catch {
    return failed('bad_multipart');
  }

  /** @type {Map<string, string | File>} */
  const fields = new Map();
  for (const [name, value] of form.entries()) {
    if (!FIELD_NAMES.includes(name) || fields.has(name)) return failed('bad_multipart');
    fields.set(name, value);
  }
  if (fields.size !== FIELD_NAMES.length) return failed('bad_multipart');
  const reportEntry = /** @type {string | File} */ (fields.get('report'));
  const shotEntry = /** @type {string | File} */ (fields.get('screenshot'));
  const annotatedEntry = /** @type {string | File} */ (fields.get('annotated'));
  if (typeof shotEntry === 'string' || typeof annotatedEntry === 'string') return failed('bad_multipart');

  /** @type {unknown} */
  let reportJson;
  try {
    const text = typeof reportEntry === 'string' ? reportEntry : await reportEntry.text();
    reportJson = JSON.parse(text);
  } catch {
    return failed('bad_report');
  }
  const parsed = parseReport(reportJson);
  if (!parsed.ok) return failed('bad_report');
  const report = parsed.report;

  /** @type {Buffer} */
  let screenshot;
  /** @type {Buffer} */
  let annotated;
  try {
    if (shotEntry.size > MAX_IMAGE_BYTES || annotatedEntry.size > MAX_IMAGE_BYTES) return failed('bad_image');
    screenshot = Buffer.from(await shotEntry.arrayBuffer());
    annotated = Buffer.from(await annotatedEntry.arrayBuffer());
  } catch {
    return failed('bad_multipart');
  }
  const expected = { width: report.screenshot.width, height: report.screenshot.height };
  if (!imageOk(screenshot, expected) || !imageOk(annotated, expected)) return failed('bad_image');

  return { ok: true, report, screenshot, annotated };
}

module.exports = {
  openReportEnvelope,
  ERROR_CODES,
  MAX_ENVELOPE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
};
