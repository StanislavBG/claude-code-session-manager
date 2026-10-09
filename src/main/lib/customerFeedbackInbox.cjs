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
const atomicFs = require('./atomicFs.cjs');
const schedulerPaths = require('./schedulerPaths.cjs');
const { resolveFeedbackBase, fromWireType, FEEDBACK_SLUG } = require('./customerFeedbackClient.cjs');

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

/**
 * @typedef {{ id: string, receivedAt: string|number|null, tag: string, title: string, body: string,
 *   clientVersion: string|null, clientPlatform: string|null, moderation: string|null, status: string,
 *   statusNote: string|null, statusAt: string|number|null, epicId: string|null }} InboxItem
 * @typedef {{ items: InboxItem[], nextSince: string|null, nextModeratedSince: string|null }} Store
 * @typedef {{ fetchImpl?: typeof fetch, storeFile?: string, ownerFile?: string,
 *   env?: Record<string, string|undefined>, now?: () => number }} Deps
 */

/** @param {Deps} [deps] */
function ctx(deps) {
  const d = deps || {};
  return {
    fetchImpl: d.fetchImpl || globalThis.fetch,
    storeFile: d.storeFile || path.join(schedulerPaths.schedulerHome(), 'customer-feedback-inbox.json'),
    ownerFile: d.ownerFile || path.join(schedulerPaths.schedulerHome(), 'customer-feedback-owner.json'),
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
  };
}

/**
 * @param {Deps} [deps]
 * @returns {Promise<{ ok: true, fetched: number, pages: number } | { ok: false, error: string }>}
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
  return { ok: true, fetched: fetched.length, pages };
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
};
