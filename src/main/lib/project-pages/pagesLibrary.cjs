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
  return { id, path: file, mtimeMs: st.mtimeMs, meta, error };
}

async function listKind(realCwd, kind) {
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
  const entries = (await Promise.all(dirs.map((d) => readEntry(kind, path.join(root, d.name), d.name)))).filter(Boolean);
  const stamp = (e) => {
    const t = e.meta ? Date.parse(e.meta.createdAt) : NaN;
    return Number.isFinite(t) ? t : e.mtimeMs;
  };
  return entries.sort((a, b) => stamp(b) - stamp(a));
}

/** -> { knowledge: Entry[], videos: Entry[] }, newest first. */
async function listLibrary(realCwd) {
  const [knowledge, videos] = await Promise.all(KINDS.map((k) => listKind(realCwd, k)));
  return { knowledge, videos };
}

/** Copy `src` into `destDir/index.html` + meta; true only after a byte-equal verified copy. */
async function copyIntoEntry(src, srcBuf, destDir, meta) {
  const dest = path.join(destDir, 'index.html');
  await config.writeTextAtomic(dest, srcBuf.toString('utf8'), { writer: WRITER });
  const back = await fsp.readFile(dest);
  if (!back.equals(srcBuf)) return false;
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
    if (await copyIntoEntry(home, homeBuf, overviewDir, meta)) await renameMigrated(home);
  }

  // demo-video/index.html -> videos/legacy-<sha10>/
  const demo = pagesPath(realCwd, 'demo-video', 'index.html');
  const demoBuf = await readIfFile(demo);
  if (demoBuf) {
    const st = await fsp.stat(demo);
    const id = `legacy-${crypto.createHash('sha256').update(demoBuf).digest('hex').slice(0, 10)}`;
    const meta = {
      id,
      title: 'Demo video',
      kind: 'project-demo',
      style: 'legacy',
      lengthS: demoLengthS(demoBuf.toString('utf8')),
      createdAt: new Date(st.mtimeMs).toISOString(),
      character: null,
      sources: [],
      report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: demoBuf.length },
      macroVersion: 0,
      seedVersion: 0,
      model: 'unknown',
      effort: 'unknown',
    };
    if (await copyIntoEntry(demo, demoBuf, pagesPath(realCwd, 'videos', id), meta)) await renameMigrated(demo);
  }
}

module.exports = { listLibrary, migrateLegacy };
