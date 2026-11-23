'use strict';

/**
 * webhookRegistry.cjs — the local webhook subscription registry (one primitive:
 * URL + kinds filter + HMAC secret), per project.
 *
 * Store: session-manager-operations/webhooks/subscriptions.json, mode 0600,
 * written only here as writer 'webhooks' (opsOwnership.cjs). Runtime state,
 * self-ignored — it holds secrets and must never be committed.
 *
 *   { version: 1, subscriptions: [{ id, url, kinds, secret, createdAt }] }
 *
 * LOOPBACK ONLY: a subscription URL must be plain http to exactly 127.0.0.1,
 * [::1] or localhost (optional port, optional path). Anything else — https,
 * another host, a lookalike such as 127.0.0.1.nip.io or localhost.evil.com
 * (DNS-rebinding style), userinfo, a numeric alias like 0x7f000001 — is refused
 * with a WebhookUrlRefusedError (code 'webhook_url_refused'). The check is on
 * the literal text the caller sent AND on the WHATWG-parsed hostname, so no
 * normalization trick can turn an accepted string into another host.
 *
 * kinds must be a non-empty list of epicEventLog.cjs EVENT_KINDS; otherwise a
 * WebhookKindsInvalidError (code 'webhook_kinds_invalid').
 *
 * The secret (32 random bytes, hex) is returned once by addSubscription;
 * listSubscriptions omits it unless { includeSecrets: true } (for an in-process
 * deliverer). Delivery lives in webhookDelivery.cjs; its per-subscriber
 * cursors + backoff persist in webhooks/delivery-state.json (mode 0600), also
 * written only here (readDeliveryState / updateDeliveryState):
 *
 *   { version: 1, cursors: { <subId>: { <epicId>: seq } },
 *     backoff: { <subId>: { failures, nextAttemptAt } } }
 *
 * The bilko.run relay (webRemote.cjs) is unrelated and untouched.
 */

const crypto = require('node:crypto');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const { writeJsonAtomic, readJsonOr } = require('../util/atomicFs.cjs');

const WRITER = 'webhooks';
const NS = 'webhooks';
const FILE_NAME = 'subscriptions.json';
const STATE_FILE_NAME = 'delivery-state.json';
const MAX_SUBSCRIPTIONS = 100;
const MAX_URL_CHARS = 2048;
const ID_RE = /^wh_[0-9a-f]{16}$/;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '[::1]', 'localhost']);
// Literal form: http://<loopback host>[:port][/path][?query]. No userinfo,
// no fragment, no whitespace, no trailing-dot hosts.
const LOOPBACK_URL_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(?::(\d{1,5}))?(?:[/?][^\s#]*)?$/;

class WebhookUrlRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookUrlRefusedError';
    this.code = 'webhook_url_refused';
  }
}

class WebhookKindsInvalidError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookKindsInvalidError';
    this.code = 'webhook_kinds_invalid';
  }
}

class WebhookNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookNotFoundError';
    this.code = 'webhook_not_found';
  }
}

/**
 * Validate a subscription URL; returns the accepted string unchanged or throws
 * WebhookUrlRefusedError.
 * @param {unknown} url
 */
function assertLoopbackUrl(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_URL_CHARS) {
    throw new WebhookUrlRefusedError('webhook url must be a non-empty string');
  }
  const m = LOOPBACK_URL_RE.exec(url);
  if (!m) {
    throw new WebhookUrlRefusedError(
      `webhook url refused: only http://127.0.0.1, http://[::1] and http://localhost are allowed, got ${JSON.stringify(url)}`,
    );
  }
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535) throw new WebhookUrlRefusedError(`webhook url refused: port ${m[2]} out of range`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookUrlRefusedError(`webhook url refused: unparsable ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || !LOOPBACK_HOSTS.includes(parsed.hostname)) {
    throw new WebhookUrlRefusedError(`webhook url refused: parsed host ${JSON.stringify(parsed.hostname)} is not loopback`);
  }
  return url;
}

/**
 * Validate kinds against epicEventLog.cjs EVENT_KINDS; returns a de-duplicated copy.
 * @param {unknown} kinds
 * @returns {string[]}
 */
function assertKinds(kinds) {
  const { EVENT_KINDS } = require('../epic/epicEventLog.cjs');
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new WebhookKindsInvalidError('webhook kinds must be a non-empty array of event kinds');
  }
  const known = new Set(EVENT_KINDS);
  const bad = kinds.filter((k) => typeof k !== 'string' || !known.has(k));
  if (bad.length) {
    throw new WebhookKindsInvalidError(`unknown event kind(s): ${bad.map((k) => JSON.stringify(k)).join(', ')}`);
  }
  return [...new Set(kinds)];
}

function storeFile(cwd) {
  return opsPath(cwd, NS, FILE_NAME);
}

/** @param {string} file */
async function readStore(file) {
  const raw = await readJsonOr(file, null);
  const subs = raw && Array.isArray(raw.subscriptions) ? raw.subscriptions : [];
  return subs.filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && typeof s.url === 'string');
}

/** @param {string} file @param {object[]} subscriptions */
async function writeStore(file, subscriptions) {
  assertOpsWrite(file, WRITER);
  await writeJsonAtomic(file, { version: 1, subscriptions }, { mode: 0o600 });
}

/** file path → tail of its mutation chain (serializes read-modify-write). */
const chains = new Map();
/**
 * @template T
 * @param {string} file @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialized(file, fn) {
  const prev = chains.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  chains.set(file, tail);
  tail.then(() => { if (chains.get(file) === tail) chains.delete(file); });
  return next;
}

/** @param {{ id: string, url: string, kinds: string[], createdAt: string, secret?: string }} s */
function publicView(s) {
  return { id: s.id, url: s.url, kinds: [...s.kinds], createdAt: s.createdAt };
}

/**
 * addSubscription({ cwd, url, kinds }) → Promise<{ id, secret }>.
 * Validates before touching disk.
 * @param {{ cwd: string, url: unknown, kinds: unknown }} opts
 */
async function addSubscription({ cwd, url, kinds } = /** @type {any} */ ({})) {
  const acceptedUrl = assertLoopbackUrl(url);
  const acceptedKinds = assertKinds(kinds);
  const file = storeFile(cwd);
  return serialized(file, async () => {
    const subs = await readStore(file);
    if (subs.length >= MAX_SUBSCRIPTIONS) throw new Error(`webhook registry full (${MAX_SUBSCRIPTIONS} subscriptions)`);
    const id = `wh_${crypto.randomBytes(8).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    subs.push({ id, url: acceptedUrl, kinds: acceptedKinds, secret, createdAt: new Date().toISOString() });
    await writeStore(file, subs);
    return { id, secret };
  });
}

/**
 * listSubscriptions({ cwd, includeSecrets }) → Promise<subscription[]>.
 * Secrets are omitted unless includeSecrets is true.
 * @param {{ cwd: string, includeSecrets?: boolean }} opts
 */
async function listSubscriptions({ cwd, includeSecrets = false } = /** @type {any} */ ({})) {
  const subs = await readStore(storeFile(cwd));
  return subs.map((s) => (includeSecrets ? { ...publicView(s), secret: s.secret } : publicView(s)));
}

/**
 * removeSubscription({ cwd, id }) → Promise<{ removed: true }>; throws
 * WebhookNotFoundError for an unknown id.
 * @param {{ cwd: string, id: unknown }} opts
 */
async function removeSubscription({ cwd, id } = /** @type {any} */ ({})) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new WebhookNotFoundError(`no webhook subscription ${JSON.stringify(id)}`);
  const file = storeFile(cwd);
  return serialized(file, async () => {
    const subs = await readStore(file);
    const kept = subs.filter((s) => s.id !== id);
    if (kept.length === subs.length) throw new WebhookNotFoundError(`no webhook subscription ${JSON.stringify(id)}`);
    await writeStore(file, kept);
    return { removed: true };
  });
}

function stateFile(cwd) {
  return opsPath(cwd, NS, STATE_FILE_NAME);
}

/** @param {any} raw */
function normalizeState(raw) {
  const isObj = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
  /** @type {{ cursors: Record<string, Record<string, number>>, backoff: Record<string, { failures: number, nextAttemptAt: number }> }} */
  const out = { cursors: {}, backoff: {} };
  if (!isObj(raw)) return out;
  if (isObj(raw.cursors)) {
    for (const [subId, perEpic] of Object.entries(raw.cursors)) {
      if (!isObj(perEpic)) continue;
      /** @type {Record<string, number>} */
      const m = {};
      for (const [epicId, seq] of Object.entries(perEpic)) if (Number.isInteger(seq) && seq > 0) m[epicId] = seq;
      out.cursors[subId] = m;
    }
  }
  if (isObj(raw.backoff)) {
    for (const [subId, b] of Object.entries(raw.backoff)) {
      if (isObj(b) && Number.isInteger(b.failures) && b.failures > 0 && Number.isFinite(b.nextAttemptAt)) {
        out.backoff[subId] = { failures: b.failures, nextAttemptAt: b.nextAttemptAt };
      }
    }
  }
  return out;
}

/**
 * readDeliveryState({ cwd }) → Promise<{ cursors, backoff }> (empty when absent).
 * @param {{ cwd: string }} opts
 */
async function readDeliveryState({ cwd } = /** @type {any} */ ({})) {
  return normalizeState(await readJsonOr(stateFile(cwd), null));
}

/**
 * updateDeliveryState({ cwd, mutate }) — serialized read-modify-write of the
 * delivery state; `mutate(state)` edits in place. Entries for subscriptions
 * that no longer exist are pruned on every write.
 * @param {{ cwd: string, mutate: (state: { cursors: Record<string, Record<string, number>>, backoff: Record<string, { failures: number, nextAttemptAt: number }> }) => void }} opts
 */
async function updateDeliveryState({ cwd, mutate } = /** @type {any} */ ({})) {
  const file = stateFile(cwd);
  return serialized(file, async () => {
    const state = normalizeState(await readJsonOr(file, null));
    mutate(state);
    const live = new Set((await readStore(storeFile(cwd))).map((s) => s.id));
    for (const key of ['cursors', 'backoff']) {
      const m = /** @type {Record<string, unknown>} */ (state[/** @type {'cursors'|'backoff'} */ (key)]);
      for (const id of Object.keys(m)) if (!live.has(id)) delete m[id];
    }
    assertOpsWrite(file, WRITER);
    await writeJsonAtomic(file, { version: 1, ...state }, { mode: 0o600 });
    return state;
  });
}

module.exports = {
  addSubscription,
  readDeliveryState,
  updateDeliveryState,
  listSubscriptions,
  removeSubscription,
  assertLoopbackUrl,
  assertKinds,
  WebhookUrlRefusedError,
  WebhookKindsInvalidError,
  WebhookNotFoundError,
  LOOPBACK_HOSTS,
};
