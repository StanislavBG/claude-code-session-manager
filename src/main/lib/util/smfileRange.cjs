'use strict';

/**
 * smfileRange.cjs — HTTP Range (RFC 9110 §14) streaming for smfile:// media.
 *
 * Audio/video elements seek by issuing `Range: bytes=…` requests; a whole-file
 * buffered read cannot serve a large rendered reel. These helpers stream just
 * the requested slice with fs.createReadStream. Home containment is the
 * caller's job (assertInsideHome runs before buildMediaResponse).
 */

const fs = require('node:fs');
const { Readable } = require('node:stream');
const { smfileResponseHeaders } = require('../smfileHeaders.cjs');

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parse a single-range `Range` header against a file size.
 * Absent or malformed (incl. multi-range) headers return null: per RFC 9110 a
 * server ignores a Range it cannot parse and sends the full 200 body.
 * @param {string|null|undefined} header
 * @param {number} size
 * @returns {null | {start:number,end:number} | {unsatisfiable:true}}
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || header === '') return null;
  const m = RANGE_RE.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    // suffix range: last n bytes
    const n = Number(b);
    if (n === 0 || size === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  let end = b === '' ? size - 1 : Number(b);
  if (b !== '' && end < start) return null;
  if (start >= size) return { unsatisfiable: true };
  if (end > size - 1) end = size - 1;
  return { start, end };
}

/**
 * Build a streaming Response (200 / 206 / 416) for a media file.
 * @param {string} realPath  already containment-checked real path
 * @param {import('node:fs').Stats} stat
 * @param {string|null|undefined} rangeHeader
 * @param {string} type  content type
 * @returns {Response}
 */
function buildMediaResponse(realPath, stat, rangeHeader, type) {
  const size = stat.size;
  const base = { ...smfileResponseHeaders(realPath, type), 'accept-ranges': 'bytes' };
  const range = parseRange(rangeHeader, size);
  if (range && 'unsatisfiable' in range) {
    return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } });
  }
  if (!range) {
    const body = size === 0 ? null : Readable.toWeb(fs.createReadStream(realPath));
    return new Response(body, { status: 200, headers: { ...base, 'content-length': String(size) } });
  }
  const { start, end } = range;
  const body = Readable.toWeb(fs.createReadStream(realPath, { start, end }));
  return new Response(body, {
    status: 206,
    headers: {
      ...base,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    },
  });
}

module.exports = { parseRange, buildMediaResponse };
