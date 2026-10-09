// @ts-check
/**
 * customerFeedbackClient — customer side of in-app feedback.
 *
 * Validates a submission, POSTs it to the bilko.run per-project feedback API, records it in a
 * machine-global store (~/.claude/session-manager/customer-feedback.json) so the user can see what
 * they sent, and refreshes each item's resolution status via a receipt-based lookup endpoint that
 * may not exist on the host yet (404 degrades to `unsupported`).
 *
 * Sends no identity: client = {app, version, platform} only. Deliberately NOT gated on
 * SM_TELEMETRY — feedback is an explicit user action.
 */
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const atomicFs = require('./atomicFs.cjs');
const schedulerPaths = require('./schedulerPaths.cjs');

const FEEDBACK_SLUG = 'session-manager';
const TAGS = /** @type {const} */ (['bug', 'feature', 'discussion']);
const MAX_TITLE = 120;
const MAX_BODY = 4000;
const MAX_ITEMS = 500;
const MAX_LOOKUP = 100;
const TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 1;
const RATE_LIMIT_ERROR = 'Too many submissions — try again in a minute.';

/**
 * @typedef {{ id: string, receipt: string|null, tag: string, title: string, body: string,
 *   submittedAt: number, status: string, statusNote: string|null,
 *   statusAt: number|string|null, seenStatusAt: number|string|null }} FeedbackItem
 * @typedef {{ fetchImpl?: typeof fetch, storeFile?: string, now?: () => number, appVersion?: string }} Deps
 */

function resolveFeedbackBase() {
  return (process.env.SM_FEEDBACK_ENDPOINT || 'https://bilko.run').replace(/\/+$/, '');
}

/** @param {string} tag */
function toWireType(tag) {
  return tag === 'discussion' ? 'feedback' : tag;
}

/** @param {string} type */
function fromWireType(type) {
  return type === 'feedback' ? 'discussion' : type;
}

/**
 * @param {{ title?: unknown, body?: unknown, tag?: unknown }} input
 * @returns {{ ok: true, value: { title: string, body: string, tag: string } } | { ok: false, error: string }}
 */
function validateSubmission(input) {
  const src = input || {};
  const title = typeof src.title === 'string' ? src.title.trim() : '';
  const body = typeof src.body === 'string' ? src.body.trim() : '';
  const tag = src.tag;
  if (!title) return { ok: false, error: 'Please enter a title.' };
  if (title.length > MAX_TITLE) return { ok: false, error: `Title must be ${MAX_TITLE} characters or fewer.` };
  if (!body) return { ok: false, error: 'Please enter a description.' };
  if (body.length > MAX_BODY) return { ok: false, error: `Description must be ${MAX_BODY} characters or fewer.` };
  if (typeof tag !== 'string' || !TAGS.includes(/** @type {any} */ (tag))) {
    return { ok: false, error: `Tag must be one of: ${TAGS.join(', ')}.` };
  }
  return { ok: true, value: { title, body, tag } };
}

function defaultStoreFile() {
  return path.join(schedulerPaths.schedulerHome(), 'customer-feedback.json');
}

function defaultVersion() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getVersion === 'function') return electron.app.getVersion();
  } catch { /* not running under Electron */ }
  try {
    return String(require('../../../package.json').version || 'unknown');
  } catch {
    return 'unknown';
  }
}

/** @param {Deps} [deps] */
function ctx(deps) {
  const d = deps || {};
  return {
    fetchImpl: d.fetchImpl || globalThis.fetch,
    storeFile: d.storeFile || defaultStoreFile(),
    now: d.now || Date.now,
    appVersion: d.appVersion || defaultVersion(),
  };
}

/** @param {string} file @returns {Promise<FeedbackItem[]>} */
async function readItems(file) {
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (data && Array.isArray(data.items)) return data.items.filter((/** @type {unknown} */ i) => i && typeof i === 'object');
  } catch { /* missing or corrupt reads as empty */ }
  return [];
}

let writeQueue = Promise.resolve();
/**
 * Serialized read-modify-write: each mutation reads the freshest on-disk items.
 * @param {string} file
 * @param {(items: FeedbackItem[]) => FeedbackItem[]} mutate
 */
function mutateStore(file, mutate) {
  const run = async () => {
    const next = mutate(await readItems(file));
    const capped = next.slice(0, MAX_ITEMS);
    await atomicFs.writeJsonAtomic(file, { schemaVersion: SCHEMA_VERSION, items: capped }, { mode: 0o600 });
    return capped;
  };
  const tail = writeQueue.then(run, run);
  writeQueue = tail.then(() => {}, () => {});
  return tail;
}

/** Items newest-first (store order). @param {Deps} [deps] */
async function list(deps) {
  return readItems(ctx(deps).storeFile);
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

/**
 * @param {{ title?: unknown, body?: unknown, tag?: unknown }} input
 * @param {Deps} [deps]
 * @returns {Promise<{ ok: true, item: FeedbackItem } | { ok: false, error: string }>}
 */
async function submit(input, deps) {
  const v = validateSubmission(input);
  if (!v.ok) return v;
  const c = ctx(deps);
  const { title, body, tag } = v.value;
  try {
    const res = await c.fetchImpl(`${resolveFeedbackBase()}/api/projects/${FEEDBACK_SLUG}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'page', id: 'desktop-app', label: 'Session Manager desktop' },
        type: toWireType(tag),
        title,
        description: body,
        client: { app: 'session-manager', version: c.appVersion, platform: process.platform },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) return { ok: false, error: RATE_LIMIT_ERROR };
    if (res.status !== 201) return { ok: false, error: await errorText(res, `Feedback service returned ${res.status}.`) };
    /** @type {any} */
    const j = await res.json().catch(() => null);
    if (!j || typeof j.id !== 'string' || !j.id) return { ok: false, error: 'Feedback service returned an unexpected response.' };
    /** @type {FeedbackItem} */
    const item = {
      id: j.id,
      receipt: typeof j.receipt === 'string' && j.receipt ? j.receipt : null,
      tag,
      title,
      body,
      submittedAt: c.now(),
      status: 'open',
      statusNote: null,
      statusAt: null,
      seenStatusAt: null,
    };
    await mutateStore(c.storeFile, (items) => [item, ...items]);
    return { ok: true, item };
  } catch (e) {
    return { ok: false, error: `Could not reach the feedback service: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * @param {Deps} [deps]
 * @returns {Promise<{ ok: true, updated: number, unsupported?: true } | { ok: false, error: string }>}
 */
async function refreshStatuses(deps) {
  const c = ctx(deps);
  const lookup = (await readItems(c.storeFile))
    .filter((i) => typeof i.receipt === 'string' && i.receipt)
    .slice(0, MAX_LOOKUP)
    .map((i) => ({ id: i.id, receipt: i.receipt }));
  if (lookup.length === 0) return { ok: true, updated: 0 };
  try {
    const res = await c.fetchImpl(`${resolveFeedbackBase()}/api/projects/${FEEDBACK_SLUG}/feedback/status-lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: lookup }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: true, updated: 0, unsupported: true };
    if (!res.ok) return { ok: false, error: await errorText(res, `Feedback service returned ${res.status}.`) };
    /** @type {any} */
    const j = await res.json().catch(() => null);
    const entries = j && Array.isArray(j.items) ? j.items : [];
    /** @type {Map<string, any>} */
    const byId = new Map();
    for (const e of entries) if (e && typeof e.id === 'string') byId.set(e.id, e);
    let updated = 0;
    await mutateStore(c.storeFile, (items) => {
      updated = 0;
      return items.map((it) => {
        const e = byId.get(it.id);
        if (!e || typeof e.status !== 'string') return it;
        updated++;
        return {
          ...it,
          status: e.status,
          statusNote: typeof e.note === 'string' ? e.note : null,
          statusAt: e.statusAt ?? null,
        };
      });
    });
    return { ok: true, updated };
  } catch (e) {
    return { ok: false, error: `Could not reach the feedback service: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** @param {string[]} [ids] omit to mark everything seen @param {Deps} [deps] */
async function markSeen(ids, deps) {
  const c = ctx(deps);
  const only = Array.isArray(ids) ? new Set(ids) : null;
  return mutateStore(c.storeFile, (items) =>
    items.map((it) => (!only || only.has(it.id) ? { ...it, seenStatusAt: it.statusAt ?? null } : it)));
}

/** @param {FeedbackItem[]} items */
function unseenCount(items) {
  return (items || []).filter((i) => i.statusAt != null && i.statusAt !== i.seenStatusAt).length;
}

module.exports = {
  FEEDBACK_SLUG,
  TAGS,
  MAX_TITLE,
  MAX_BODY,
  resolveFeedbackBase,
  toWireType,
  fromWireType,
  validateSubmission,
  submit,
  list,
  refreshStatuses,
  markSeen,
  unseenCount,
};
