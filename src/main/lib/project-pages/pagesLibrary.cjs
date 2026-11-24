'use strict';

/**
 * pagesLibrary.cjs — Project Home library storage. One folder per entry under
 * `project-pages/knowledge/<id>/` and `project-pages/videos/<id>/`, each with
 * `index.html` + `meta.json`. The folder listing IS the library (no manifest).
 * listLibrary() reads it newest-first; migrateLegacy() moves the old single
 * `home.html` and `demo-video/index.html` into it exactly once, keeping the
 * originals as `<name>.migrated`. All writes go through config.writeTextAtomic
 * with writer 'project-home' (single-writer law, opsOwnership.cjs).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../../config.cjs');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const { injectPlayerBridge } = require('./playerBridge.cjs');
const { readCharacter } = require('../demo-video-kit/character.cjs');

const WRITER = 'project-home';
const MAX_ENTRIES = 500;
const SKIP_DIRS = new Set(['_character']);
const KINDS = /** @type {const} */ (['knowledge', 'videos']);

/** opsPath, with the ephemeral-cwd throw mapped to null ("nothing to do"). */
function pagesPath(realCwd, ...parts) {
  try {
    return opsPath(realCwd, 'project-pages', ...parts);
  } catch (e) {
    if (e && e.ephemeral) return null;
    throw e;
  }
}

function oneLine(msg) {
  return String(msg).replace(/\s+/g, ' ').trim().slice(0, 200) || 'invalid meta';
}

async function readEntry(kind, dir, id) {
  const file = path.join(dir, 'index.html');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null; // folder without index.html is not an entry
  }
  const { schemas } = require('../../ipcSchemas.cjs');
  const schema = kind === 'videos' ? schemas.projectVideoMeta : schemas.projectPageMeta;
  let meta = null;
  let error = null;
  try {
    const raw = await fsp.readFile(path.join(dir, 'meta.json'), 'utf8');
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) meta = parsed.data;
    else error = oneLine(`meta.json invalid: ${parsed.error.issues[0]?.path.join('.') || ''} ${parsed.error.issues[0]?.message || ''}`);
  } catch (e) {
    error = oneLine(e && e.code === 'ENOENT' ? 'meta.json missing' : `meta.json unreadable: ${e && e.message}`);
  }
  const entry = { id, path: file, mtimeMs: st.mtimeMs, meta, error };
  if (kind === 'videos') entry.exports = await readExports(dir);
  return entry;
}

/** Absolute path of `file` when it exists as a regular file, else null. */
async function fileOrNull(file) {
  try {
    return (await fsp.stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Fixed names the save route writes: video.mp4 + poster.png. */
async function readExports(dir) {
  const [mp4, poster] = await Promise.all([
    fileOrNull(path.join(dir, 'video.mp4')),
    fileOrNull(path.join(dir, 'poster.png')),
  ]);
  return { mp4, poster };
}

/** -> { name } when videos/_character holds a valid character, else null. Never throws. */
function readPersona(realCwd) {
  try {
    const c = readCharacter(realCwd);
    return c ? { name: c.json.name } : null;
  } catch {
    return null;
  }
}

/** The only outcome a run may record instead of a video (projectHomeAdminRoutes.cjs VIDEO_OUTCOMES). */
const VIDEO_OUTCOMES = new Set(['season-complete']);

/**
 * -> { id, outcome, text, at } from videos/<id>/outcome.json (written by
 * project_video_outcome_write), or null when absent, unreadable or invalid. Never throws.
 */
async function readOutcome(dir, id) {
  let rec;
  try {
    rec = JSON.parse(await fsp.readFile(path.join(dir, 'outcome.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const { outcome, text, at } = rec;
  if (rec.id !== id || !VIDEO_OUTCOMES.has(outcome)) return null;
  if (typeof text !== 'string' || !text.trim() || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  return { id, outcome, text, at };
}

/** Lists one kind's entries; for videos, folders with no index.html but a valid outcome.json go to `outcomes`. */
async function listKind(realCwd, kind, outcomes = []) {
  const root = pagesPath(realCwd, kind);
  if (!root) return [];
  let dirents;
  try {
    dirents = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const dirs = dirents.filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name)).slice(0, MAX_ENTRIES);
  const read = await Promise.all(dirs.map((d) => readEntry(kind, path.join(root, d.name), d.name)));
  if (kind === 'videos') {
    const found = await Promise.all(
      dirs.map((d, i) => (read[i] ? null : readOutcome(path.join(root, d.name), d.name))),
    );
    for (const o of found) if (o) outcomes.push(o);
    outcomes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
  const entries = read.filter(Boolean);
  const stamp = (e) => {
    const t = e.meta ? Date.parse(e.meta.createdAt) : NaN;
    return Number.isFinite(t) ? t : e.mtimeMs;
  };
  return entries.sort((a, b) => stamp(b) - stamp(a));
}

/**
 * -> { knowledge: Entry[], videos: Entry[] (with exports), persona: {name}|null,
 *      outcomes: {id, outcome, text, at}[] (video folders with an outcome and no index.html) }, newest first.
 */
async function listLibrary(realCwd) {
  const outcomes = [];
  const [knowledge, videos] = await Promise.all(KINDS.map((k) => listKind(realCwd, k, outcomes)));
  const persona = pagesPath(realCwd) ? readPersona(realCwd) : null;
  return { knowledge, videos, persona, outcomes };
}

/** Write `outBuf` into `destDir/index.html` + meta; true only after a byte-equal verified write. */
async function copyIntoEntry(outBuf, destDir, meta) {
  const dest = path.join(destDir, 'index.html');
  await config.writeTextAtomic(dest, outBuf.toString('utf8'), { writer: WRITER });
  const back = await fsp.readFile(dest);
  if (!back.equals(outBuf)) return false;
  await config.writeTextAtomic(path.join(destDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { writer: WRITER });
  return true;
}

/** Rename through the same validation + ownership check writeTextAtomic uses. */
async function renameMigrated(file) {
  const real = config.validatePath(file);
  config.validateWrite(real);
  assertOpsWrite(real, WRITER);
  const target = `${real}.migrated`;
  config.validateWrite(target);
  assertOpsWrite(target, WRITER);
  await fsp.rename(real, target);
}

async function readIfFile(file) {
  try {
    return await fsp.readFile(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function demoLengthS(html) {
  const m = /<meta\s+name=["']sm-demo-duration["']\s+content=["'](\d+(?:\.\d+)?)["']/i.exec(html);
  const n = m ? Math.round(Number(m[1])) : NaN;
  return Number.isFinite(n) && n >= 5 && n <= 60 ? n : 30;
}

/** One-shot move of the legacy home.html / demo-video/index.html into the library. Idempotent. */
async function migrateLegacy(realCwd) {
  const home = pagesPath(realCwd, 'home.html');
  if (!home) return;

  // home.html -> knowledge/overview/
  const overviewDir = pagesPath(realCwd, 'knowledge', 'overview');
  const homeBuf = await readIfFile(home);
  if (homeBuf && !fs.existsSync(overviewDir)) {
    const st = await fsp.stat(home);
    const meta = {
      id: 'overview',
      title: 'Overview',
      topic: 'overview',
      createdAt: new Date(st.mtimeMs).toISOString(),
      model: 'unknown',
    };
    if (await copyIntoEntry(homeBuf, overviewDir, meta)) await renameMigrated(home);
  }

  // demo-video/index.html -> videos/legacy-<sha10>/
  const demo = pagesPath(realCwd, 'demo-video', 'index.html');
  const demoBuf = await readIfFile(demo);
  if (demoBuf) {
    const st = await fsp.stat(demo);
    const id = `legacy-${crypto.createHash('sha256').update(demoBuf).digest('hex').slice(0, 10)}`;
    // Bridge goes into the migrated copy only; the id hashes the ORIGINAL bytes.
    const bridgedBuf = Buffer.from(injectPlayerBridge(demoBuf.toString('utf8')), 'utf8');
    const meta = {
      id,
      title: 'Demo video',
      kind: 'project-demo',
      style: 'legacy',
      lengthS: demoLengthS(demoBuf.toString('utf8')),
      createdAt: new Date(st.mtimeMs).toISOString(),
      character: null,
      sources: [],
      report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: bridgedBuf.length },
      macroVersion: 0,
      seedVersion: 0,
      model: 'unknown',
      effort: 'unknown',
    };
    if (await copyIntoEntry(bridgedBuf, pagesPath(realCwd, 'videos', id), meta)) await renameMigrated(demo);
  }
}

module.exports = { listLibrary, migrateLegacy };
