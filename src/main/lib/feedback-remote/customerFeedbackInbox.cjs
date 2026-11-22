// @ts-check
/**
 * customerFeedbackInbox — OWNER side of customer feedback.
 *
 * With an owner token configured (env SM_FEEDBACK_OWNER_TOKEN or
 * ~/.claude/session-manager/customer-feedback-owner.json) this machine incrementally pulls every
 * submission for the session-manager slug from bilko.run into a local mirror, sets item status on
 * the host, and records which local Epic an item became. No token = customer machine (ownerMode
 * false). The token is only ever sent as a bearer header and never appears in errors or the mirror.
 */
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const atomicFs = require('../util/atomicFs.cjs');
const schedulerPaths = require('../scheduler/schedulerPaths.cjs');
const { resolveFeedbackBase, fromWireType, FEEDBACK_SLUG } = require('./customerFeedbackClient.cjs');
const { ATTACHMENT_MIMES, sniffImageMime } = require('../epic/epicAttachments.cjs');

const STATUSES = /** @type {const} */ (['open', 'in_progress', 'resolved', 'wontfix']);
const MAX_NOTE = 500;
const MAX_ITEMS = 2000;
const PAGE_LIMIT = 500;
const MAX_PAGES = 10;
const TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 1;
const NO_TOKEN = 'Feedback owner token not configured';
const NO_STATUS_SUPPORT = 'Host does not support feedback status yet (or unknown id)';
const HIDDEN = new Set(['archived', 'deleted']);
const MAX_ITEM_IMAGES = 5;
const MAX_IMAGE_FETCHES = 20;
const MAX_DATA_URL_CHARS = 2000000;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * @typedef {{ mime: string, bytes: number, path: string|null }} InboxImage
 * @typedef {{ id: string, receivedAt: string|number|null, tag: string, title: string, body: string,
 *   clientVersion: string|null, clientPlatform: string|null, moderation: string|null, status: string,
 *   statusNote: string|null, statusAt: string|number|null, epicId: string|null, images?: InboxImage[] }} InboxItem
 * @typedef {{ items: InboxItem[], nextSince: string|null, nextModeratedSince: string|null }} Store
 * @typedef {{ fetchImpl?: typeof fetch, storeFile?: string, ownerFile?: string, imagesDir?: string,
 *   env?: Record<string, string|undefined>, now?: () => number }} Deps
 */

/** @param {Deps} [deps] */
function ctx(deps) {
  const d = deps || {};
  return {
    fetchImpl: d.fetchImpl || globalThis.fetch,
    storeFile: d.storeFile || path.join(schedulerPaths.schedulerHome(), 'customer-feedback-inbox.json'),
    ownerFile: d.ownerFile || path.join(schedulerPaths.schedulerHome(), 'customer-feedback-owner.json'),
    imagesDir: d.imagesDir || path.join(schedulerPaths.schedulerHome(), 'customer-feedback-images'),
    env: d.env || process.env,
    now: d.now || Date.now,
  };
}

/** @param {Deps} [deps] @returns {{ token: string, projectCwd: string|null }|null} */
function loadOwnerConfig(deps) {
  const c = ctx(deps);
  const envToken = (c.env.SM_FEEDBACK_OWNER_TOKEN || '').trim();
  if (envToken) return { token: envToken, projectCwd: c.env.SM_FEEDBACK_OWNER_PROJECT_CWD || null };
  try {
    const j = JSON.parse(require('node:fs').readFileSync(c.ownerFile, 'utf8'));
    const token = j && typeof j.token === 'string' ? j.token.trim() : '';
    if (token) return { token, projectCwd: typeof j.projectCwd === 'string' && j.projectCwd ? j.projectCwd : null };
  } catch { /* missing or corrupt = not an owner */ }
  return null;
}

/** Never includes the token. @param {Deps} [deps] */
function getOwnerInfo(deps) {
  const cfg = loadOwnerConfig(deps);
  return { ownerMode: !!cfg, projectCwd: cfg ? cfg.projectCwd : null };
}

/** @param {string} file @returns {Promise<Store>} */
async function readStore(file) {
  try {
    const j = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (j && Array.isArray(j.items)) {
      return {
        items: j.items.filter((/** @type {unknown} */ i) => i && typeof i === 'object'),
        nextSince: typeof j.nextSince === 'string' ? j.nextSince : null,
        nextModeratedSince: typeof j.nextModeratedSince === 'string' ? j.nextModeratedSince : null,
      };
    }
  } catch { /* missing or corrupt reads as empty */ }
  return { items: [], nextSince: null, nextModeratedSince: null };
}

let writeQueue = Promise.resolve();
/**
 * Serialized read-modify-write over the mirror.
 * @template T
 * @param {string} file
 * @param {(s: Store) => T} mutate mutates the store in place, returns a result
 * @returns {Promise<T>}
 */
function mutateStore(file, mutate) {
  const run = async () => {
    const store = await readStore(file);
    const result = mutate(store);
    store.items = sortItems(store.items).slice(0, MAX_ITEMS);
    await atomicFs.writeJsonAtomic(file, { schemaVersion: SCHEMA_VERSION, ...store }, { mode: 0o600 });
    return result;
  };
  const tail = writeQueue.then(run, run);
  writeQueue = tail.then(() => {}, () => {});
  return tail;
}

/** @param {InboxItem[]} items */
function sortItems(items) {
  const t = (/** @type {InboxItem} */ i) => (i.receivedAt == null ? 0 : (typeof i.receivedAt === 'number' ? i.receivedAt : Date.parse(i.receivedAt) || 0));
  return items.slice().sort((a, b) => t(b) - t(a));
}

/** @param {string} s @param {string} token */
function redact(s, token) {
  return token ? s.split(token).join('[redacted]') : s;
}

/** @param {unknown} e @param {string} token */
function netError(e, token) {
  return `Could not reach the feedback service: ${redact(e instanceof Error ? e.message : String(e), token)}`;
}

/** @param {Response} res @param {string} fallback */
async function errorText(res, fallback) {
  try {
    /** @type {any} */
    const j = await res.json();
    if (j && typeof j.error === 'string' && j.error) return j.error;
  } catch { /* no body */ }
  return fallback;
}

/** @param {number} status */
function httpError(status) {
  if (status === 401) return 'Feedback owner token was rejected (401).';
  if (status === 503) return 'Host has no feedback owner token configured (503).';
  return `Feedback service returned ${status}.`;
}

/** @param {any} w @param {InboxItem|undefined} prev @returns {InboxItem} */
function toItem(w, prev) {
  const client = w.client && typeof w.client === 'object' ? w.client : {};
  const st = w.status && typeof w.status === 'object' ? w.status : null;
  return {
    id: w.id,
    receivedAt: w.receivedAt ?? null,
    tag: fromWireType(String(w.type)),
    title: String(w.title ?? ''),
    body: String(w.description ?? ''),
    clientVersion: typeof client.version === 'string' ? client.version : null,
    clientPlatform: typeof client.platform === 'string' ? client.platform : null,
    moderation: w.moderation && typeof w.moderation.action === 'string' ? w.moderation.action : null,
    status: st && typeof st.value === 'string' ? st.value : 'open',
    statusNote: st && typeof st.note === 'string' ? st.note : null,
    statusAt: st ? (st.at ?? null) : null,
    epicId: prev && prev.epicId ? prev.epicId : null,
    images: toImages(w.images, prev),
  };
}

/** @param {unknown} wireImages @param {InboxItem|undefined} prev @returns {InboxImage[]} */
function toImages(wireImages, prev) {
  if (!Array.isArray(wireImages)) return [];
  const prevImages = prev && Array.isArray(prev.images) ? prev.images : [];
  return wireImages.slice(0, MAX_ITEM_IMAGES).map((/** @type {any} */ im, i) => {
    const p = prevImages[i];
    return {
      mime: im && typeof im.mime === 'string' ? im.mime : '',
      bytes: im && typeof im.bytes === 'number' && Number.isFinite(im.bytes) ? im.bytes : 0,
      path: p && typeof p.path === 'string' && p.path ? p.path : null,
    };
  });
}

/** @param {string} file */
async function fileExists(file) {
  try { return (await fsp.stat(file)).isFile(); } catch { return false; }
}

/** @param {InboxItem} item @returns {Promise<boolean>} true when any image lacks a cached file */
async function needsImages(item) {
  const images = Array.isArray(item.images) ? item.images : [];
  for (const im of images) {
    if (!im.path || !(await fileExists(im.path))) return true;
  }
  return false;
}

/**
 * Validate one wire image entry; returns decoded bytes + mime, or null.
 * @param {any} entry @param {string} declaredMime
 * @returns {{ buf: Buffer, mime: string }|null}
 */
function decodeImage(entry, declaredMime) {
  const dataUrl = entry && typeof entry.dataUrl === 'string' ? entry.dataUrl : null;
  if (!dataUrl || dataUrl.length > MAX_DATA_URL_CHARS) return null;
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const mime = `image/${m[1]}`;
  if (declaredMime && declaredMime !== mime) return null;
  if (entry.mime !== undefined && entry.mime !== mime) return null;
  const payload = dataUrl.slice(m[0].length);
  if (!payload || payload.length % 4 !== 0 || !BASE64_RE.test(payload)) return null;
  const buf = Buffer.from(payload, 'base64');
  if (sniffImageMime(buf) !== mime) return null;
  return { buf, mime };
}

/** @param {string|number|null} receivedAt @returns {string|null} */
function sinceBefore(receivedAt) {
  const t = typeof receivedAt === 'number' ? receivedAt : (typeof receivedAt === 'string' ? Date.parse(receivedAt) : NaN);
  if (!Number.isFinite(t)) return null;
  return new Date(t - 1000).toISOString();
}

/**
 * Download + cache images for up to MAX_IMAGE_FETCHES items. Never throws, never logs bytes.
 * @param {ReturnType<typeof ctx>} c @param {string} base @param {string} token @param {string[]} fetchedIds
 * @returns {Promise<number>} images written
 */
async function cacheImages(c, base, token, fetchedIds) {
  const store = await readStore(c.storeFile);
  const fetchedSet = new Set(fetchedIds);
  const ordered = [
    ...store.items.filter((i) => fetchedSet.has(i.id)),
    ...sortItems(store.items).filter((i) => !fetchedSet.has(i.id)),
  ];
  /** @type {InboxItem[]} */
  const todo = [];
  for (const item of ordered) {
    if (todo.length >= MAX_IMAGE_FETCHES) break;
    if (typeof item.id !== 'string' || !SAFE_ID_RE.test(item.id)) continue;
    if (!Array.isArray(item.images) || !item.images.length) continue;
    if (await needsImages(item)) todo.push(item);
  }
  /** @type {Map<string, (string|null)[]>} */
  const written = new Map();
  let count = 0;
  for (const item of todo) {
    try {
      const since = sinceBefore(item.receivedAt);
      if (!since) continue;
      const qs = new URLSearchParams({ since, limit: String(MAX_IMAGE_FETCHES) });
      const res = await c.fetchImpl(`${base}?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 200) continue;
      /** @type {any} */
      const j = await res.json().catch(() => null);
      const w = j && Array.isArray(j.items) ? j.items.find((/** @type {any} */ x) => x && x.id === item.id) : null;
      if (!w || !Array.isArray(w.images)) continue;
      const images = item.images || [];
      /** @type {(string|null)[]} */
      const paths = images.map((im) => im.path);
      for (let i = 0; i < images.length; i++) {
        if (paths[i] && (await fileExists(/** @type {string} */ (paths[i])))) continue;
        paths[i] = null;
        const dec = decodeImage(w.images[i], images[i].mime);
        if (!dec) continue;
        const ext = /** @type {Record<string, string>} */ (ATTACHMENT_MIMES)[dec.mime];
        if (!ext) continue;
        const file = path.join(c.imagesDir, item.id, `${i + 1}${ext}`);
        try {
          await atomicFs.writeTextAtomic(file, dec.buf, { mode: 0o600 });
          paths[i] = file;
          count++;
        } catch { /* disk error: leave null, retry next pull */ }
      }
      written.set(item.id, paths);
    } catch { /* network / timeout: leave paths null, retry next pull (error intentionally dropped; no bytes, no token) */ }
  }
  if (written.size) {
    await mutateStore(c.storeFile, (s) => {
      for (const it of s.items) {
        const paths = written.get(it.id);
        if (!paths || !Array.isArray(it.images)) continue;
        it.images = it.images.map((im, i) => ({ ...im, path: paths[i] !== undefined ? paths[i] : im.path }));
      }
    });
  }
  return count;
}

/** Remove cache dirs whose id is no longer in the mirror. @param {ReturnType<typeof ctx>} c */
async function pruneImages(c) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try { entries = await fsp.readdir(c.imagesDir, { withFileTypes: true }); } catch { return; }
  const ids = new Set((await readStore(c.storeFile)).items.map((i) => i.id));
  for (const e of entries) {
    if (ids.has(e.name)) continue;
    try { await fsp.rm(path.join(c.imagesDir, e.name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * @param {Deps} [deps]
 * @returns {Promise<{ ok: true, fetched: number, pages: number, imagesCached: number } | { ok: false, error: string }>}
 */
async function pull(deps) {
  const cfg = loadOwnerConfig(deps);
  if (!cfg) return { ok: false, error: NO_TOKEN };
  const c = ctx(deps);
  const base = `${resolveFeedbackBase()}/api/projects/${FEEDBACK_SLUG}/feedback`;
  const prior = await readStore(c.storeFile);
  let since = prior.nextSince;
  let moderatedSince = prior.nextModeratedSince;
  /** @type {any[]} */
  const fetched = [];
  let pages = 0;
  try {
    for (; pages < MAX_PAGES;) {
      const qs = new URLSearchParams();
      if (since) qs.set('since', since);
      if (moderatedSince) qs.set('moderatedSince', moderatedSince);
      qs.set('images', 'none');
      qs.set('limit', String(PAGE_LIMIT));
      const res = await c.fetchImpl(`${base}?${qs.toString()}`, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: await errorText(res, httpError(res.status)) };
      /** @type {any} */
      const j = await res.json().catch(() => null);
      if (!j || !Array.isArray(j.items)) return { ok: false, error: 'Feedback service returned an unexpected response.' };
      pages++;
      fetched.push(...j.items.filter((/** @type {any} */ i) => i && typeof i.id === 'string' && i.id));
      if (typeof j.nextSince === 'string') since = j.nextSince;
      if (typeof j.nextModeratedSince === 'string') moderatedSince = j.nextModeratedSince;
      if (j.items.length < PAGE_LIMIT) break;
    }
  } catch (e) {
    return { ok: false, error: netError(e, cfg.token) };
  }
  const finalSince = since;
  const finalModerated = moderatedSince;
  await mutateStore(c.storeFile, (store) => {
    const byId = new Map(store.items.map((i) => [i.id, i]));
    for (const w of fetched) byId.set(w.id, toItem(w, byId.get(w.id)));
    store.items = [...byId.values()];
    store.nextSince = finalSince;
    store.nextModeratedSince = finalModerated;
  });
  let imagesCached = 0;
  try {
    imagesCached = await cacheImages(c, base, cfg.token, fetched.map((w) => w.id));
  } catch { /* image caching never fails the pull */ }
  await pruneImages(c);
  return { ok: true, fetched: fetched.length, pages, imagesCached };
}

/**
 * Read one cached image back as a data URL (owner only).
 * @param {string} id @param {number} index 0-based @param {Deps} [deps]
 * @returns {Promise<{ ok: true, dataUrl: string } | { ok: false, error: string }>}
 */
async function readCachedImage(id, index, deps) {
  if (!loadOwnerConfig(deps)) return { ok: false, error: NO_TOKEN };
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) return { ok: false, error: 'Invalid feedback id.' };
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_ITEM_IMAGES) {
    return { ok: false, error: 'Invalid image index.' };
  }
  const c = ctx(deps);
  const item = (await readStore(c.storeFile)).items.find((i) => i.id === id);
  const im = item && Array.isArray(item.images) ? item.images[index] : undefined;
  const file = im && typeof im.path === 'string' ? path.resolve(im.path) : null;
  const root = path.resolve(c.imagesDir, id) + path.sep;
  if (!file || !file.startsWith(root)) return { ok: false, error: 'Image not cached.' };
  /** @type {Buffer} */
  let buf;
  try { buf = await fsp.readFile(file); } catch { return { ok: false, error: 'Image not cached.' }; }
  const mime = sniffImageMime(buf);
  if (!mime) return { ok: false, error: 'Cached file is not an image.' };
  return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

/**
 * @param {{ includeHidden?: boolean }} [opts] @param {Deps} [deps]
 * @returns {Promise<{ ok: true, items: InboxItem[] } | { ok: false, error: string }>}
 */
async function list(opts, deps) {
  if (!loadOwnerConfig(deps)) return { ok: false, error: NO_TOKEN };
  const store = await readStore(ctx(deps).storeFile);
  const includeHidden = !!(opts && opts.includeHidden);
  const items = sortItems(store.items).filter((i) => includeHidden || !(i.moderation && HIDDEN.has(i.moderation)));
  return { ok: true, items };
}

/**
 * @param {string} id @param {string} status @param {string} [note] @param {Deps} [deps]
 * @returns {Promise<{ ok: true, item: InboxItem|null } | { ok: false, error: string }>}
 */
async function setStatus(id, status, note, deps) {
  const cfg = loadOwnerConfig(deps);
  if (!cfg) return { ok: false, error: NO_TOKEN };
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Feedback id is required.' };
  if (!STATUSES.includes(/** @type {any} */ (status))) return { ok: false, error: `Status must be one of: ${STATUSES.join(', ')}.` };
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) {
    return { ok: false, error: `Note must be ${MAX_NOTE} characters or fewer.` };
  }
  const c = ctx(deps);
  try {
    const res = await c.fetchImpl(`${resolveFeedbackBase()}/api/projects/${FEEDBACK_SLUG}/feedback/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(note ? { status, note } : { status }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: false, error: NO_STATUS_SUPPORT };
    if (res.status !== 200) return { ok: false, error: await errorText(res, httpError(res.status)) };
    /** @type {any} */
    const j = await res.json().catch(() => null);
    const statusAt = j && j.statusAt != null ? j.statusAt : c.now();
    const item = await mutateStore(c.storeFile, (store) => {
      const it = store.items.find((i) => i.id === id);
      if (!it) return null;
      it.status = status;
      it.statusNote = note || null;
      it.statusAt = statusAt;
      return it;
    });
    return { ok: true, item };
  } catch (e) {
    return { ok: false, error: netError(e, cfg.token) };
  }
}

/**
 * Local-only: record which Epic an item was turned into.
 * @param {string} id @param {string} epicId @param {Deps} [deps]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function linkEpic(id, epicId, deps) {
  if (!loadOwnerConfig(deps)) return { ok: false, error: NO_TOKEN };
  if (typeof epicId !== 'string' || !epicId) return { ok: false, error: 'Epic id is required.' };
  const found = await mutateStore(ctx(deps).storeFile, (store) => {
    const it = store.items.find((i) => i.id === id);
    if (!it) return false;
    it.epicId = epicId;
    return true;
  });
  return found ? { ok: true } : { ok: false, error: 'Unknown feedback id.' };
}

module.exports = {
  STATUSES,
  loadOwnerConfig,
  getOwnerInfo,
  pull,
  list,
  setStatus,
  linkEpic,
  readCachedImage,
};
