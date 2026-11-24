'use strict';

/**
 * artifactStore.cjs — the per-project Artifacts store. THE ONLY WRITER of a
 * project's `session-manager-operations/artifacts/` namespace (writer id
 * 'artifacts' in lib/opsOwnership.cjs; runtime, self-ignored).
 *
 * Files an agent makes for human review (videos, images, docs, data) are
 * copied out of the job/Epic worktree into the MAIN project's ops root so they
 * survive worktree teardown and show in the File Explorer without a merge.
 *
 * Layout:
 *   artifacts/<epic-id>/<name>            Epic-owned artifacts
 *   artifacts/<epic-id>/index.json        that owner's ledger
 *   artifacts/_tasks/<task-id>/<name>     Task-owned artifacts (+ index.json)
 * Ledger: { version: 1, entries: [{ name, title, kind, size, sha256, createdAt,
 *   producer: { epicId, prdSlug, sessionId, taskId } }] }.
 *
 * Never overwrites: a name collision gets a -2, -3, ... suffix. All writes for
 * one owner folder (name pick, copy, ledger read-modify-write) are serialized
 * by an in-process promise lock. publishArtifact/ingestDir never throw — every
 * refusal is a returned { ok:false, error } / skipped reason.
 *
 * Retention: artifactsDays after the owning Epic completes (pruning lives in a
 * sibling module).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { opsPath, checkOpsWrite, assertOpsWrite } = require('../opsOwnership.cjs');
const { writeJsonAtomic, readJsonOrSync } = require('../util/atomicFs.cjs');

const NAMESPACE = 'artifacts';
const WRITER = 'artifacts';
const TASKS_DIR = '_tasks';
const LEDGER = 'index.json';
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MAX_INGEST_FILES = 200;
const MAX_TITLE_CHARS = 500;
const EPIC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KINDS = Object.freeze(['video', 'audio', 'image', 'doc', 'data', 'other']);

const EXT_KIND = Object.freeze({
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'],
  doc: ['md', 'txt', 'pdf', 'html', 'htm', 'docx', 'doc', 'rtf', 'pptx', 'odt'],
  data: ['json', 'jsonl', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'xlsx', 'sqlite', 'db', 'parquet'],
});
/** @type {Map<string, string>} */
const KIND_BY_EXT = new Map();
for (const [kind, exts] of Object.entries(EXT_KIND)) for (const e of exts) KIND_BY_EXT.set(e, kind);

/** owner folder abs path → tail of its lock chain. */
const locks = new Map();

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

function inferKind(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return KIND_BY_EXT.get(ext) || 'other';
}

/** Safe file name from a source basename: no separators, no leading dot, bounded. */
function safeName(base) {
  let n = String(base).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.\s]+/, '').trim();
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n || 'artifact';
}

/** First free name in `dir`: name, name-2.ext, name-3.ext, ... (index.json is reserved). */
function freeName(dir, name, fsImpl) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 100000; i += 1) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    if (candidate === LEDGER) continue;
    if (!fsImpl.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error('no free artifact name');
}

function isUnder(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha256File(file, fsImpl) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = (fsImpl.createReadStream || fs.createReadStream)(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Run `fn` after every earlier holder of `key`'s lock. */
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  const cleanup = () => { if (locks.get(key) === next) locks.delete(key); };
  next.then(cleanup, cleanup);
  return next;
}

/** Owner id + folder segments, or an error string. */
function ownerOf(epicId, taskId) {
  const hasEpic = epicId !== undefined && epicId !== null && epicId !== '';
  const hasTask = taskId !== undefined && taskId !== null && taskId !== '';
  if (hasEpic === hasTask) return { error: 'exactly one of epicId or taskId is required' };
  if (hasEpic) {
    if (typeof epicId !== 'string' || !EPIC_ID_RE.test(epicId)) return { error: 'unsafe epicId' };
    return { ownerId: epicId, segs: [epicId] };
  }
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return { error: 'unsafe taskId' };
  return { ownerId: `${TASKS_DIR}/${taskId}`, segs: [TASKS_DIR, taskId] };
}

/**
 * Read a ledger's entries through fsImpl; missing, empty, corrupt or entries-not-an-array → [].
 */
function readLedger(file, fsImpl) {
  const parsed = readJsonOrSync(file, null, fsImpl);
  const entries = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.entries) ? parsed.entries : null;
  if (!entries) return [];
  return entries.filter((e) => e && typeof e === 'object' && typeof e.name === 'string');
}

function cleanProducer(producer, epicId, taskId) {
  const p = producer && typeof producer === 'object' ? producer : {};
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
  return {
    epicId: str(p.epicId) || str(epicId),
    prdSlug: str(p.prdSlug),
    sessionId: str(p.sessionId),
    taskId: str(p.taskId) || str(taskId),
  };
}

/**
 * publishArtifact({ projectRoot, epicId, taskId, srcPath, title, kind, producer,
 *   allowedRoots, fsImpl, appendEvent })
 *   → Promise<{ ok: true, storedPath, entry } | { ok: false, error }>
 * Never rejects.
 */
async function publishArtifact({
  projectRoot, epicId, taskId, srcPath, title, kind, producer, allowedRoots,
  fsImpl = fs, appendEvent = null,
} = {}) {
  try {
    const owner = ownerOf(epicId, taskId);
    if (owner.error) return { ok: false, error: owner.error };
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
      return { ok: false, error: 'projectRoot must be an absolute path' };
    }
    if (typeof srcPath !== 'string' || !path.isAbsolute(srcPath)) {
      return { ok: false, error: 'srcPath must be an absolute path' };
    }
    if (kind !== undefined && kind !== null && !KINDS.includes(kind)) {
      return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` };
    }

    let st;
    try { st = fsImpl.lstatSync(srcPath); } catch (e) { return { ok: false, error: `source unreadable: ${errMsg(e)}` }; }
    if (st.isSymbolicLink()) return { ok: false, error: 'source is a symlink' };
    if (!st.isFile()) return { ok: false, error: 'source is not a regular file' };
    if (st.size > MAX_BYTES) return { ok: false, error: `oversize (${st.size} > ${MAX_BYTES} bytes)` };

    let realSrc;
    try { realSrc = fsImpl.realpathSync(srcPath); } catch (e) { return { ok: false, error: `source unresolvable: ${errMsg(e)}` }; }
    const roots = (Array.isArray(allowedRoots) && allowedRoots.length ? allowedRoots : [projectRoot])
      .filter((r) => typeof r === 'string' && path.isAbsolute(r))
      .map((r) => { try { return fsImpl.realpathSync(r); } catch { return null; } })
      .filter(Boolean);
    if (!roots.some((r) => isUnder(realSrc, /** @type {string} */ (r)))) {
      return { ok: false, error: 'source is outside every allowed root' };
    }

    let destDir;
    let nsDir;
    try {
      destDir = path.resolve(opsPath(projectRoot, NAMESPACE, ...owner.segs));
      nsDir = path.resolve(opsPath(projectRoot, NAMESPACE));
    } catch (e) {
      return { ok: false, error: `destination refused: ${errMsg(e)}` };
    }
    if (isUnder(realSrc, destDir)) return { ok: false, error: 'source is already inside the artifacts store' };
    const resolvedRoot = path.dirname(path.dirname(nsDir));
    const ledgerFile = path.join(destDir, LEDGER);

    return await withLock(destDir, async () => {
      fsImpl.mkdirSync(destDir, { recursive: true });
      const name = freeName(destDir, safeName(path.basename(srcPath)), fsImpl);
      const dest = path.join(destDir, name);
      const verdict = checkOpsWrite(dest, WRITER);
      if (!verdict.ok) return { ok: false, error: `write refused: ${verdict.error}` };
      assertOpsWrite(dest, WRITER);
      assertOpsWrite(ledgerFile, WRITER);

      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let sha256;
      let size;
      try {
        fsImpl.copyFileSync(realSrc, tmp, fs.constants.COPYFILE_FICLONE);
        size = fsImpl.statSync(tmp).size;
        if (size > MAX_BYTES) throw new Error(`oversize after copy (${size} > ${MAX_BYTES} bytes)`);
        sha256 = await sha256File(tmp, fsImpl);
        if (fsImpl.existsSync(dest)) throw new Error('destination appeared during copy');
        fsImpl.renameSync(tmp, dest);
      } catch (e) {
        try { fsImpl.unlinkSync(tmp); } catch { /* never created or already gone */ }
        return { ok: false, error: `copy failed: ${errMsg(e)}` };
      }

      const entry = {
        name,
        title: (typeof title === 'string' && title.trim() ? title.trim() : name).slice(0, MAX_TITLE_CHARS),
        kind: kind || inferKind(name),
        size,
        sha256,
        createdAt: new Date().toISOString(),
        producer: cleanProducer(producer, epicId, taskId),
      };
      try {
        const entries = readLedger(ledgerFile, fsImpl);
        entries.push(entry);
        await writeJsonAtomic(ledgerFile, { version: 1, entries });
      } catch (e) {
        try { fsImpl.unlinkSync(dest); } catch { /* best effort: keep store and ledger in step */ }
        return { ok: false, error: `ledger write failed: ${errMsg(e)}` };
      }

      if (owner.segs[0] !== TASKS_DIR) {
        try {
          const append = appendEvent || require('./epicEventLog.cjs').appendEpicEvent;
          await append(projectRoot, epicId, {
            kind: 'artifact.published',
            name: entry.name,
            title: entry.title,
            artifactKind: entry.kind,
            size: entry.size,
            path: path.relative(resolvedRoot, dest).split(path.sep).join('/'),
          });
        } catch (e) {
          console.error('[artifactStore] artifact.published event append failed', epicId, name, errMsg(e));
        }
      }
      return { ok: true, storedPath: dest, entry };
    });
  } catch (e) {
    return { ok: false, error: `publish failed: ${errMsg(e)}` };
  }
}

/**
 * ingestDir({ projectRoot, epicId, taskId, srcDir, producer, allowedRoots, minAgeMs, fsImpl, appendEvent })
 *   → Promise<{ published: { srcPath, storedPath, entry }[], skipped: { path, reason }[] }>
 * Publishes every regular file directly in srcDir (non-recursive, max 200),
 * deleting each source only after its copy succeeded. Never rejects.
 * minAgeMs (default 0) skips any file modified within the last minAgeMs as
 * 'still being written', so a periodic sweep never moves a half-written file.
 */
async function ingestDir({
  projectRoot, epicId, taskId, srcDir, producer, allowedRoots, minAgeMs = 0, fsImpl = fs, appendEvent = null,
} = {}) {
  /** @type {{ srcPath: string, storedPath: string, entry: object }[]} */
  const published = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  try {
    if (typeof srcDir !== 'string' || !path.isAbsolute(srcDir)) {
      skipped.push({ path: String(srcDir), reason: 'srcDir must be an absolute path' });
      return { published, skipped };
    }
    let names;
    try {
      const st = fsImpl.lstatSync(srcDir);
      if (!st.isDirectory()) {
        skipped.push({ path: srcDir, reason: 'srcDir is not a directory' });
        return { published, skipped };
      }
      names = fsImpl.readdirSync(srcDir).map(String).sort();
    } catch (e) {
      if (e && e.code === 'ENOENT') return { published, skipped };
      skipped.push({ path: srcDir, reason: `cannot list srcDir: ${errMsg(e)}` });
      return { published, skipped };
    }
    const roots = Array.isArray(allowedRoots) && allowedRoots.length ? allowedRoots : [srcDir];
    const minAge = Number.isFinite(minAgeMs) && minAgeMs > 0 ? minAgeMs : 0;
    const cutoff = Date.now() - minAge;
    let count = 0;
    for (const name of names) {
      const src = path.join(srcDir, name);
      try {
        const st = fsImpl.lstatSync(src);
        if (st.isSymbolicLink()) { skipped.push({ path: src, reason: 'symlink' }); continue; }
        if (st.isDirectory()) { skipped.push({ path: src, reason: 'directory' }); continue; }
        if (!st.isFile()) { skipped.push({ path: src, reason: 'not a regular file' }); continue; }
        if (minAge > 0 && st.mtimeMs > cutoff) { skipped.push({ path: src, reason: 'still being written' }); continue; }
        if (count >= MAX_INGEST_FILES) { skipped.push({ path: src, reason: `over the ${MAX_INGEST_FILES}-file limit` }); continue; }
        count += 1;
        const res = await publishArtifact({
          projectRoot, epicId, taskId, srcPath: src, producer, allowedRoots: roots, fsImpl, appendEvent,
        });
        if (!res.ok) { skipped.push({ path: src, reason: res.error }); continue; }
        published.push({ srcPath: src, storedPath: res.storedPath, entry: res.entry });
        try { fsImpl.unlinkSync(src); } catch (e) {
          console.error('[artifactStore] could not delete ingested source', src, errMsg(e));
        }
      } catch (e) {
        skipped.push({ path: src, reason: `ingest failed: ${errMsg(e)}` });
      }
    }
  } catch (e) {
    skipped.push({ path: String(srcDir), reason: `ingest failed: ${errMsg(e)}` });
  }
  return { published, skipped };
}

/**
 * True only when a stat of the stored file says it is gone (ENOENT/ENOTDIR).
 * Any other stat error keeps the entry — the file may well exist. Never throws.
 */
function storedFileMissing(file, fsImpl) {
  try {
    fsImpl.statSync(file);
    return false;
  } catch (e) {
    return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
  }
}

/**
 * listArtifacts(projectRoot, { fsImpl }) → entries newest first, each with
 * `ownerId` (an Epic id, or `_tasks/<task-id>`). A missing or corrupt ledger
 * contributes [] for that owner. An entry whose stored file
 * (artifacts/<owner>/<name>) no longer exists — e.g. deleted from the OS file
 * manager — is omitted (one stat per entry through fsImpl); the daily sweep
 * (artifactRetention.cjs) compacts such rows out of the ledger. Never throws.
 */
function listArtifacts(projectRoot, { fsImpl = fs } = {}) {
  /** @type {object[]} */
  const out = [];
  let nsDir;
  try { nsDir = opsPath(projectRoot, NAMESPACE); } catch { return out; }
  const dirsIn = (dir) => {
    try {
      return fsImpl.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => String(d.name));
    } catch { return []; }
  };
  /** @type {{ ownerId: string, dir: string }[]} */
  const owners = [];
  for (const name of dirsIn(nsDir)) {
    if (name === TASKS_DIR) {
      for (const t of dirsIn(path.join(nsDir, TASKS_DIR))) {
        if (TASK_ID_RE.test(t)) owners.push({ ownerId: `${TASKS_DIR}/${t}`, dir: path.join(nsDir, TASKS_DIR, t) });
      }
    } else if (EPIC_ID_RE.test(name)) {
      owners.push({ ownerId: name, dir: path.join(nsDir, name) });
    }
  }
  for (const { ownerId, dir } of owners) {
    for (const e of readLedger(path.join(dir, LEDGER), fsImpl)) {
      if (storedFileMissing(path.join(dir, e.name), fsImpl)) continue;
      out.push({ ...e, ownerId });
    }
  }
  const t = (e) => { const v = Date.parse(e.createdAt); return Number.isFinite(v) ? v : 0; };
  out.sort((a, b) => t(b) - t(a));
  return out;
}

/**
 * stagingDirFor({ runId }) → <worktreeBase>/artifact-staging/<runId>, created
 * mode 0700. Throws on an unsafe runId.
 */
function stagingDirFor({ runId } = {}) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error(`artifactStore.stagingDirFor: unsafe runId "${runId}"`);
  }
  const { worktreeBase } = require('../scheduler/schedulerPaths.cjs');
  const dir = path.join(worktreeBase(), 'artifact-staging', runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

module.exports = {
  publishArtifact,
  ingestDir,
  listArtifacts,
  stagingDirFor,
  inferKind,
  MAX_BYTES,
  MAX_INGEST_FILES,
  KINDS,
  EPIC_ID_RE,
  TASK_ID_RE,
  RUN_ID_RE,
};
