'use strict';

/**
 * videoReview.cjs — the one writer of a video entry's human review step:
 * session-manager-operations/project-pages/videos/<id>/review/ (namespace
 * 'project-pages', owner 'project-home' in lib/opsOwnership.cjs).
 *
 *   dispatch.json  — written by the app when a review-tool run is queued
 *   material.json  — + image-1.<ext> .. image-N.<ext>, written by the
 *                    agent-facing review write tool (writeMaterial)
 *   decision.json  — written ONLY by the human decision IPC (writeDecision)
 *
 * reviewStatus() derives the state from those three records, purely.
 * Plain Node: no Electron import. Paths come from opsPath; every write goes
 * through assertOpsWrite + util/atomicFs.cjs (tmp+rename).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const { writeJsonAtomic, writeTextAtomic, readJsonOr } = require('../util/atomicFs.cjs');
const { ENTRY_ID_RE } = require('../../ipcSchemas.cjs');

const WRITER = 'project-home';
const REVIEW_MATERIAL_REL = 'session-manager-operations/project-pages/videos/{id}/review/material.json';
const REVIEW_TEXT_MAX = 32000;
const REVIEW_IMAGES_MAX = 6;
const REVIEW_IMAGE_BYTES_MAX = 2 * 1024 * 1024;
const NOTE_MAX = 2000;
const AT_MAX = 40;
const STAGE_MAX = 40;
const DECISIONS = Object.freeze(['approve', 'changes']);
const IMAGE_NAME_RE = /^image-\d+\.(png|jpg|webp)$/;

/** Strictly increasing ISO stamps, so records written in the same ms still order. */
let lastStampMs = 0;
function nowIso() {
  let ms = Date.now();
  if (ms <= lastStampMs) ms = lastStampMs + 1;
  lastStampMs = ms;
  return new Date(ms).toISOString();
}

function reviewDir(cwd, entryId) {
  return opsPath(cwd, 'project-pages', 'videos', entryId, 'review');
}

function validEntryId(entryId) {
  return typeof entryId === 'string' && ENTRY_ID_RE.test(entryId);
}

async function writeJson(abs, obj) {
  assertOpsWrite(abs, WRITER);
  await writeJsonAtomic(abs, obj);
}

/** -> 'png' | 'jpg' | 'webp' | null, by magic bytes only. */
function imageExt(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function readRecords(dir) {
  const [dispatch, material, decision] = await Promise.all([
    readJsonOr(path.join(dir, 'dispatch.json'), null),
    readJsonOr(path.join(dir, 'material.json'), null),
    readJsonOr(path.join(dir, 'decision.json'), null),
  ]);
  return { dispatch, material, decision };
}

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * reviewStatus({ dispatch, material, decision }) -> 'building' | 'waiting' |
 * 'approved' | 'changes-requested' | null. Pure. The newest record wins; ties
 * go to the later lifecycle step. A 'final' dispatch never outranks a decision.
 */
function reviewStatus(records) {
  const { dispatch = null, material = null, decision = null } = records || {};
  const candidates = [];
  if (dispatch && !(dispatch.stage === 'final' && decision)) {
    candidates.push({ t: ms(dispatch.dispatchedAt), rank: 0, status: 'building' });
  }
  if (material) candidates.push({ t: ms(material.savedAt), rank: 1, status: 'waiting' });
  if (decision) {
    candidates.push({
      t: ms(decision.decidedAt),
      rank: 2,
      status: decision.decision === 'approve' ? 'approved' : 'changes-requested',
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.t - a.t) || (b.rank - a.rank));
  return candidates[0].status;
}

/**
 * recordDispatch(cwd, entryId, { macroId, epicId, slug, stage, inputValues, extraInstructions })
 *   -> { ok: true, path, dispatch } | { ok: false, error }
 */
async function recordDispatch(cwd, entryId, input = {}) {
  if (!validEntryId(entryId)) return { ok: false, error: 'invalid entryId' };
  const { macroId, epicId = null, slug = '', stage, inputValues = {}, extraInstructions = '' } = input || {};
  if (typeof macroId !== 'string' || !macroId) return { ok: false, error: 'macroId required' };
  if (epicId !== null && typeof epicId !== 'string') return { ok: false, error: 'epicId must be a string or null' };
  if (typeof slug !== 'string') return { ok: false, error: 'slug must be a string' };
  if (typeof stage !== 'string' || !stage || stage.length > STAGE_MAX) return { ok: false, error: 'stage required (1-40 chars)' };
  if (!inputValues || typeof inputValues !== 'object' || Array.isArray(inputValues)) {
    return { ok: false, error: 'inputValues must be an object' };
  }
  if (typeof extraInstructions !== 'string') return { ok: false, error: 'extraInstructions must be a string' };
  const dispatch = { entryId, macroId, epicId, slug, stage, inputValues, extraInstructions, dispatchedAt: nowIso() };
  const abs = path.join(reviewDir(cwd, entryId), 'dispatch.json');
  await writeJson(abs, dispatch);
  return { ok: true, path: abs, dispatch };
}

/**
 * writeMaterial(cwd, entryId, { text, images: [{ bytes: Buffer }] })
 *   -> { ok: true, path, material } | { ok: false, error }
 * Replaces the previous material and images. Refused without dispatch.json.
 */
async function writeMaterial(cwd, entryId, input = {}) {
  if (!validEntryId(entryId)) return { ok: false, error: 'invalid entryId' };
  const { text, images } = input || {};
  if (typeof text !== 'string' || text.length < 1 || text.length > REVIEW_TEXT_MAX) {
    return { ok: false, error: `text must be 1-${REVIEW_TEXT_MAX} chars` };
  }
  if (!Array.isArray(images) || images.length < 1 || images.length > REVIEW_IMAGES_MAX) {
    return { ok: false, error: `images must be 1-${REVIEW_IMAGES_MAX} items` };
  }
  const exts = [];
  for (let i = 0; i < images.length; i++) {
    const bytes = images[i] && images[i].bytes;
    if (!Buffer.isBuffer(bytes)) return { ok: false, error: `image ${i + 1}: bytes must be a Buffer` };
    if (bytes.length > REVIEW_IMAGE_BYTES_MAX) return { ok: false, error: `image ${i + 1}: larger than 2 MiB` };
    const ext = imageExt(bytes);
    if (!ext) return { ok: false, error: `image ${i + 1}: not a PNG, JPEG or WebP` };
    exts.push(ext);
  }
  const dir = reviewDir(cwd, entryId);
  const dispatch = await readJsonOr(path.join(dir, 'dispatch.json'), null);
  if (!dispatch) return { ok: false, error: 'no dispatch for this entry' };

  const names = exts.map((ext, i) => `image-${i + 1}.${ext}`);
  for (let i = 0; i < names.length; i++) {
    const abs = path.join(dir, names[i]);
    assertOpsWrite(abs, WRITER);
    // atomicFs.writeTextAtomic writes a Buffer verbatim (encoding is ignored for Buffers).
    await writeTextAtomic(abs, images[i].bytes);
  }
  let existing = [];
  try { existing = await fsp.readdir(dir); } catch { /* dir was just created */ }
  for (const name of existing) {
    if (IMAGE_NAME_RE.test(name) && !names.includes(name)) {
      const abs = path.join(dir, name);
      assertOpsWrite(abs, WRITER);
      await fsp.unlink(abs);
    }
  }
  const material = { entryId, text, images: names.map((name) => ({ name })), savedAt: nowIso() };
  const abs = path.join(dir, 'material.json');
  await writeJson(abs, material);
  return { ok: true, path: abs, material };
}

/**
 * writeDecision(cwd, entryId, { decision, note, at }) — the human decision.
 *   -> { ok: true, path, decision } | { ok: false, error }
 */
async function writeDecision(cwd, entryId, input = {}) {
  if (!validEntryId(entryId)) return { ok: false, error: 'invalid entryId' };
  const { decision, note, at } = input || {};
  if (!DECISIONS.includes(decision)) return { ok: false, error: "decision must be 'approve' or 'changes'" };
  const record = { entryId, decision };
  if (decision === 'changes') {
    const n = typeof note === 'string' ? note.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
    if (n.length < 1 || n.length > NOTE_MAX) return { ok: false, error: `note must be 1-${NOTE_MAX} chars` };
    record.note = n;
  } else {
    if (typeof at !== 'string' || at.length < 1 || at.length > AT_MAX || /[\r\n]/.test(at)) {
      return { ok: false, error: `at must be a 1-${AT_MAX} char single line` };
    }
    record.at = at;
  }
  const dir = reviewDir(cwd, entryId);
  const { material, decision: prior } = await readRecords(dir);
  if (!material) return { ok: false, error: 'no material to decide on' };
  if (prior && ms(prior.decidedAt) >= ms(material.savedAt)) return { ok: false, error: 'already decided' };
  record.decidedAt = nowIso();
  const abs = path.join(dir, 'decision.json');
  await writeJson(abs, record);
  return { ok: true, path: abs, decision: record };
}

/** readReview(cwd, entryId) -> { entryId, dispatch, material, decision, status } | null */
async function readReview(cwd, entryId) {
  if (!validEntryId(entryId)) return null;
  const dir = reviewDir(cwd, entryId);
  if (!fs.existsSync(dir)) return null;
  const records = await readRecords(dir);
  let material = records.material;
  if (material) {
    const images = Array.isArray(material.images) ? material.images : [];
    material = {
      ...material,
      images: images
        .filter((img) => img && typeof img.name === 'string' && IMAGE_NAME_RE.test(img.name))
        .map((img) => ({ name: img.name, path: path.join(dir, img.name) })),
    };
  }
  return {
    entryId,
    dispatch: records.dispatch,
    material,
    decision: records.decision,
    status: reviewStatus(records),
  };
}

function newestStamp(r) {
  return Math.max(
    r.dispatch ? ms(r.dispatch.dispatchedAt) : -Infinity,
    r.material ? ms(r.material.savedAt) : -Infinity,
    r.decision ? ms(r.decision.decidedAt) : -Infinity,
  );
}

/** listReviews(cwd) -> every entry with a review folder, newest record first. */
async function listReviews(cwd) {
  const videosDir = opsPath(cwd, 'project-pages', 'videos');
  let names;
  try {
    names = await fsp.readdir(videosDir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    if (!validEntryId(name)) continue;
    const r = await readReview(cwd, name);
    if (r) out.push(r);
  }
  out.sort((a, b) => newestStamp(b) - newestStamp(a));
  return out;
}

module.exports = {
  REVIEW_MATERIAL_REL,
  REVIEW_TEXT_MAX,
  REVIEW_IMAGES_MAX,
  REVIEW_IMAGE_BYTES_MAX,
  recordDispatch,
  writeMaterial,
  writeDecision,
  readReview,
  listReviews,
  reviewStatus,
};
