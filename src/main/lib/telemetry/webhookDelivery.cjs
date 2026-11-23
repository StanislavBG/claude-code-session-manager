'use strict';

/**
 * webhookDelivery.cjs — delivers a project's event-log events
 * (epic/epicEventLog.cjs) to each loopback webhook subscriber
 * (webhookRegistry.cjs): HMAC-SHA256 signed, AT LEAST ONCE, in seq order.
 *
 * Request: POST <subscription url>, Content-Type application/json,
 *   body  = JSON.stringify({ subscriptionId, event })
 *   X-SM-Signature = hex HMAC-SHA256(secret, body)
 * 5 s timeout, redirects not followed (a 3xx is a failure).
 *
 * Cursor: per subscriber, per Epic, the seq of the last event the subscriber
 * answered 2xx for (webhooks/delivery-state.json, written by the registry —
 * the 'webhooks' namespace's only writer). The cursor moves ONLY on 2xx and is
 * persisted after the subscriber's pass, so a crash before that write replays
 * the already-sent events (duplicates possible, a skip is not). Receivers
 * dedupe on (event.epicId, event.seq).
 *
 * Failure: the subscriber stops for this pass at its first failed attempt and
 * backs off exponentially (BASE_BACKOFF_MS · 2^(failures-1), capped at
 * MAX_BACKOFF_MS); a 2xx clears the backoff. A pass sends at most
 * MAX_DELIVERIES_PER_PASS requests per subscriber, so one pass is bounded.
 *
 * Loopback only: every URL is re-checked with assertLoopbackUrl before a fetch,
 * even though the registry already refused anything else on add.
 *
 * Driver: no timer of its own — main's existing 5-min intraday timer calls
 * runDeliveryPass over the scheduler queue's project cwds (index.cjs). No
 * subscriptions → no event-log reads, no state write, no fetch.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { opsPath } = require('../opsOwnership.cjs');
const { readEpicEvents } = require('../epic/epicEventLog.cjs');
const registry = require('./webhookRegistry.cjs');

const REQUEST_TIMEOUT_MS = 5000;
const MAX_DELIVERIES_PER_PASS = 50;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const SIGNATURE_HEADER = 'X-SM-Signature';
const EPIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** cwd → in-flight pass (overlapping passes for one cwd share the first). */
const inFlight = new Map();

/** @param {string} secret @param {string} body */
function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** @param {number} failures */
function backoffMs(failures) {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
}

/** Epic ids that have an event log under <cwd>/session-manager-operations/events/. @param {string} cwd */
async function listEpicIds(cwd) {
  try {
    const ents = await fsp.readdir(opsPath(cwd, 'events'), { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && EPIC_ID_RE.test(e.name)).map((e) => e.name).sort();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * POST one event; resolves true on 2xx, false otherwise (never throws).
 * @param {(url: string, init: object) => Promise<{ status: number }>} fetchFn
 * @param {{ id: string, url: string, secret: string }} sub
 * @param {object} event
 */
async function postEvent(fetchFn, sub, event) {
  const body = JSON.stringify({ subscriptionId: sub.id, event });
  try {
    const res = await fetchFn(sub.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: sign(sub.secret, body) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return !!res && res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/**
 * @param {{ cwd: string, now?: () => number, fetch?: (url: string, init: object) => Promise<{ status: number }> }} opts
 * @returns {Promise<{ delivered: number, failed: number, backedOff: number, refused: number }>}
 */
async function deliverOnce({ cwd, now = Date.now, fetch: fetchFn = /** @type {any} */ (globalThis.fetch) }) {
  const result = { delivered: 0, failed: 0, backedOff: 0, refused: 0 };
  const subs = await registry.listSubscriptions({ cwd, includeSecrets: true });
  if (!subs.length) return result;
  const state = await registry.readDeliveryState({ cwd });
  const epicIds = await listEpicIds(cwd);

  for (const sub of subs) {
    try {
      registry.assertLoopbackUrl(sub.url);
    } catch {
      result.refused++;
      continue;
    }
    const b = state.backoff[sub.id];
    if (b && b.nextAttemptAt > now()) {
      result.backedOff++;
      continue;
    }
    /** @type {Record<string, number>} */
    const advanced = {};
    let budget = MAX_DELIVERIES_PER_PASS;
    let failedAt = 0;
    outer: for (const epicId of epicIds) {
      let after = (state.cursors[sub.id] || {})[epicId] || 0;
      while (budget > 0) {
        const page = await readEpicEvents(cwd, epicId, { after, limit: budget, kinds: sub.kinds });
        for (const event of page.events) {
          budget--;
          if (!(await postEvent(fetchFn, /** @type {{ id: string, url: string, secret: string }} */ (sub), event))) {
            failedAt = now();
            break outer;
          }
          result.delivered++;
          after = event.seq;
          advanced[epicId] = after;
        }
        if (!page.hasMore) break;
      }
      if (budget <= 0) break;
    }
    if (failedAt) result.failed++;
    if (!failedAt && !Object.keys(advanced).length && !b) continue; // nothing to persist
    await registry.updateDeliveryState({
      cwd,
      mutate: (s) => {
        const cur = s.cursors[sub.id] || (s.cursors[sub.id] = {});
        // Never move a cursor backwards (a concurrent writer may be ahead).
        for (const [epicId, seq] of Object.entries(advanced)) cur[epicId] = Math.max(cur[epicId] || 0, seq);
        if (failedAt) {
          const failures = ((s.backoff[sub.id] && s.backoff[sub.id].failures) || 0) + 1;
          s.backoff[sub.id] = { failures, nextAttemptAt: failedAt + backoffMs(failures) };
        } else {
          delete s.backoff[sub.id];
        }
      },
    });
  }
  return result;
}

/**
 * deliverPending({ cwd, now, fetch }) → Promise<{ delivered, failed, backedOff, refused }>.
 * One bounded delivery pass for one project. `now` (ms clock) and `fetch` are
 * injectable for tests; they default to Date.now and globalThis.fetch.
 * @param {{ cwd: string, now?: () => number, fetch?: (url: string, init: object) => Promise<{ status: number }> }} opts
 */
function deliverPending(opts) {
  const key = opts && opts.cwd;
  if (typeof key !== 'string' || !key) return Promise.reject(new Error('deliverPending: cwd required'));
  const running = inFlight.get(key);
  if (running) return running;
  const p = deliverOnce(opts).finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/**
 * runDeliveryPass({ cwds, logs }) — sequential deliverPending over cwds; each
 * project's failure is logged and never stops the others. Never rejects.
 * @param {{ cwds: Iterable<string>, logs?: { writeLine: (entry: object) => void } }} opts
 */
async function runDeliveryPass({ cwds, logs }) {
  for (const cwd of new Set(cwds)) {
    try {
      const r = await deliverPending({ cwd });
      if (r.failed && logs) {
        logs.writeLine({ scope: 'webhooks', level: 'warn', message: 'webhook delivery failed', meta: { cwd, ...r } });
      }
    } catch (e) {
      if (logs) logs.writeLine({ scope: 'webhooks', level: 'error', message: 'webhook delivery pass failed', meta: { cwd, error: /** @type {Error} */ (e)?.message } });
    }
  }
}

function _resetForTests() {
  inFlight.clear();
}

module.exports = {
  deliverPending,
  runDeliveryPass,
  sign,
  REQUEST_TIMEOUT_MS,
  MAX_DELIVERIES_PER_PASS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  SIGNATURE_HEADER,
  _resetForTests,
};
