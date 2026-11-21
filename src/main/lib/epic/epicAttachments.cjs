'use strict';
// @ts-check

/**
 * epicAttachments.cjs — validate + save base64 images sent from the phone
 * remote into the same dir the desktop Epic composer uses
 * (<project>/session-manager-operations/prompt-sessions/attachments/), and
 * compose the prompt with the same `Attached: <abs path>` lines
 * (EpicComposer.tsx) so Claude reads them with its Read tool.
 *
 * Writes go through config.cjs writeBinaryAtomic under writer 'epics'
 * (single-writer law). config.cjs is required lazily — it pulls Electron.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { opsPath } = require('../opsOwnership.cjs');

const ATTACHMENT_MIMES = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
});
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** sniffImageMime(buf) → one of ATTACHMENT_MIMES' keys, or null. */
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('latin1');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** safeAttachmentName(name, mime) → sanitized basename with the mime's extension. */
function safeAttachmentName(name, mime) {
  const ext = ATTACHMENT_MIMES[mime] || '';
  let base = typeof name === 'string' ? name : '';
  base = base.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  else if (dot === 0) base = base.slice(1);
  base = base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  if (!base || /^[.-]+$/.test(base)) base = 'image';
  return `${base}${ext}`;
}

function attachmentsDir(projectCwd) {
  return opsPath(projectCwd, 'prompt-sessions', 'attachments');
}

/**
 * saveChatImages({ projectCwd, images }, deps?) →
 *   { ok: true, paths, names } | { ok: false, reason }
 * images: [{ name, mime, data (base64) }]. Validates all before writing any.
 */
async function saveChatImages({ projectCwd, images }, deps = {}) {
  const list = Array.isArray(images) ? images : [];
  if (list.length > MAX_IMAGES) return { ok: false, reason: 'too-many' };
  const decoded = [];
  let total = 0;
  for (const img of list) {
    if (!img || typeof img !== 'object') return { ok: false, reason: 'bad-data' };
    const { name, mime, data } = img;
    if (typeof mime !== 'string' || !Object.prototype.hasOwnProperty.call(ATTACHMENT_MIMES, mime)) {
      return { ok: false, reason: 'bad-type' };
    }
    if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      return { ok: false, reason: 'bad-data' };
    }
    // Cheap pre-decode size bound so a huge payload is refused before allocation.
    if (Math.floor((data.length * 3) / 4) - 2 > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0) return { ok: false, reason: 'bad-data' };
    if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) return { ok: false, reason: 'too-large' };
    if (sniffImageMime(buf) !== mime) return { ok: false, reason: 'bad-type' };
    decoded.push({ buf, fileName: `${crypto.randomUUID().slice(0, 8)}-${safeAttachmentName(name, mime)}` });
  }

  const writeBinary = deps.writeBinary || require('../../config.cjs').writeBinaryAtomic;
  const paths = [];
  try {
    const dir = attachmentsDir(projectCwd);
    for (const { buf, fileName } of decoded) {
      const dest = path.join(dir, fileName);
      await writeBinary(dest, buf, { writer: 'epics' });
      paths.push(dest);
    }
  } catch {
    await removeSavedAttachments(projectCwd, paths, deps);
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, paths, names: paths.map((p) => path.basename(p)) };
}

/** composeAttachedPrompt(text, paths) — identical to EpicComposer.tsx. */
function composeAttachedPrompt(text, paths) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) return trimmed;
  const lines = list.map((p) => `Attached: ${p}`).join('\n');
  return trimmed ? `${trimmed}\n\n${lines}` : lines;
}

/** removeSavedAttachments(projectCwd, paths, deps?) — unlinks only files inside
 *  the project's attachments dir; never throws. */
async function removeSavedAttachments(projectCwd, paths, deps = {}) {
  const unlink = deps.unlink || fsp.unlink;
  let dir;
  try { dir = attachmentsDir(projectCwd); } catch { return; }
  const prefix = dir + path.sep;
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string') continue;
    const abs = path.resolve(p);
    if (!abs.startsWith(prefix)) continue;
    try { await unlink(abs); } catch { /* already gone */ }
  }
}

module.exports = {
  ATTACHMENT_MIMES,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  sniffImageMime,
  safeAttachmentName,
  saveChatImages,
  composeAttachedPrompt,
  removeSavedAttachments,
};
