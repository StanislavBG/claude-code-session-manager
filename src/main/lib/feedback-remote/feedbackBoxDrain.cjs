// @ts-check
/**
 * feedbackBoxDrain — moves every waiting website-widget envelope from the bilko.run relay into its
 * project's feedback-inbox/ and only then acks it (the host deletes acked envelopes).
 * Data path: session-manager-operations/architecture/site-feedback.md.
 *
 * Per local box (feedbackBoxKeys): list envelopes (limit 20, repeat until empty), download, open
 * (feedbackEnvelope.openReportEnvelope), write (siteFeedbackInbox.writeItem), ack.
 *   - open failure (any ok:false code) -> one rejected.jsonl line (no content), then ack.
 *   - writeItem refuses the hostId as stored for another report (code host_id_clash) -> one
 *     rejected.jsonl line with code host_id_clash, then ack (it would never succeed: a poison
 *     envelope must not stall its box).
 *   - network error / 5xx / 429 / any other relay failure -> stop that box for this pass, no ack;
 *     429 also defers the box by Retry-After.
 *   - 404 box_not_found -> box is gone (deleted, or re-paired under another account): reported in
 *     goneBoxes and skipped until its keystore record is removed.
 *   - projectCwd missing -> box held (not drained, nothing acked), reported in heldBoxes.
 *
 *   - any throw -> box stopped for this pass, logged with a fixed code from classifyError
 *     (write_denied, io_error, relay_error, open_failed, keystore_error).
 *
 * Verified reporter (site-feedback.md#verified-reporter): before the write, a report whose user
 * carries a string `sig` is checked against the box's identity secret (keystore.getIdentitySecret):
 * HMAC-SHA256(secret, 'v1|id|email|exp') as base64url, compared with crypto.timingSafeEqual, and
 * exp (epoch seconds) not earlier than createdAt minus 5 minutes. The result is stored as
 * meta.reporterVerified: true (valid), false (sig present but invalid, expired, or no secret) or
 * null (no sig). Neither the secret nor the sig is ever logged.
 *
 * Retention: once per project per 24 h (per drain instance) the drain calls
 * inbox.prune(cwd, feedbackInboxDays) with the days from opsRetentionSettings.read().
 *
 * Nothing logged ever carries report text, image bytes, a private key or the device token: log
 * lines name only box ids and fixed codes.
 */
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { openReportEnvelope } = require('./feedbackEnvelope.cjs');

const PAGE_LIMIT = 20;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_AFTER_SEC = 60;
const MAX_PAGES_PER_BOX = 100;
const HOST_ID_RE = /^FB-[0-9A-Z]{5}$/;
const HOST_ID_CLASH = 'host_id_clash';
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Clock skew allowed between the site's signer and the visitor's createdAt. */
const REPORTER_EXP_SKEW_MS = 5 * 60 * 1000;

/**
 * @typedef {{ ok: false, status: number, error: string, retryAfterSec?: number }} RelayFailure
 * @typedef {{ envelopeId: string, hostId: string, clientReportId?: string, receivedAt: string,
 *   origin: string, bytes?: number }} EnvelopeListing
 * @typedef {{
 *   listEnvelopes: (boxId: string, limit?: number) => Promise<{ ok: true, envelopes: EnvelopeListing[] } | RelayFailure>,
 *   getEnvelope: (boxId: string, envelopeId: string) => Promise<{ ok: true, body: Buffer } | RelayFailure>,
 *   ackEnvelope: (boxId: string, envelopeId: string) => Promise<{ ok: true } | RelayFailure>,
 * }} DrainRelay
 * @typedef {{ boxId: string, projectCwd: string }} DrainBox
 * @typedef {{
 *   listBoxes: () => Promise<DrainBox[]>,
 *   getPrivateKey: (boxId: string) => Promise<Record<string, unknown> | null>,
 *   getIdentitySecret?: (boxId: string) => Promise<string | null>,
 * }} DrainKeystore
 * @typedef {{
 *   writeItem: (args: any) => Promise<{ duplicate: boolean, hostId: string }>,
 *   appendRejected: (args: { cwd: string, at: string, boxId: string, hostId: string, code: string, bytes: number }) => Promise<void>,
 *   prune: (cwd: string, days: number) => Promise<string[]>,
 * }} DrainInbox
 * @typedef {{ relay?: DrainRelay, keystore?: DrainKeystore, inbox?: DrainInbox,
 *   now?: () => number, cwdExists?: (cwd: string) => boolean,
 *   feedbackInboxDays?: () => number,
 *   log?: (msg: string) => void }} DrainDeps
 * @typedef {{ stored: number, duplicates: number, rejected: number,
 *   goneBoxes: string[], heldBoxes: string[] }} DrainResult
 */

/** @param {string} cwd */
function defaultCwdExists(cwd) {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} msg */
function defaultLog(msg) {
  console.warn(`[feedbackBoxDrain] ${msg}`);
}

/** @returns {DrainRelay} */
function defaultRelay() {
  const { createRelayClient } = require('./feedbackRelayClient.cjs');
  return createRelayClient({
    getDeviceToken: () => require('../../webRemote.cjs').getLinkedDeviceToken(),
  });
}

/** @returns {number} */
function defaultFeedbackInboxDays() {
  return require('../opsRetentionSettings.cjs').read().feedbackInboxDays;
}

/** @param {unknown} e */
function isHostIdClash(e) {
  return !!e && typeof e === 'object' && /** @type {any} */ (e).code === HOST_ID_CLASH;
}

/** @param {unknown} code */
function safeCode(code) {
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : 'unknown';
}

/**
 * Does the report's user carry a signature, and does it verify? Pure: the caller supplies the secret.
 * @param {unknown} report  the opened Report v1
 * @param {string | null} secret  the box's identity secret (null = the box has none)
 * @returns {boolean | null} null when the user carries no sig
 */
function verifyReporter(report, secret) {
  const r = /** @type {any} */ (report);
  const u = r && typeof r === 'object' && r.user && typeof r.user === 'object' ? r.user : null;
  if (!u || typeof u.sig !== 'string' || u.sig.length === 0) return null;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const { id, email, exp, sig } = u;
  if (typeof id !== 'string' || !Number.isSafeInteger(exp)) return false;
  if (email !== undefined && email !== null && typeof email !== 'string') return false;
  const createdMs = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
  if (!Number.isFinite(createdMs) || exp * 1000 < createdMs - REPORTER_EXP_SKEW_MS) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`v1|${id}|${typeof email === 'string' ? email : ''}|${exp}`)
    .digest();
  const given = Buffer.from(sig, 'utf8');
  const want = Buffer.from(expected.toString('base64url'), 'utf8');
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

/** @typedef {'keystore' | 'relay' | 'open' | 'write'} DrainStage */

const DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Map an error thrown mid-box to a fixed, content-free code for the log line. A write-stage
 * error without a system errno is a boundary/ownership refusal (config.cjs validateWrite,
 * opsOwnership assertOpsWrite, siteFeedbackInbox's own cwd checks): write_denied.
 * @param {DrainStage} stage
 * @param {unknown} e
 * @returns {string}
 */
function classifyError(stage, e) {
  const code = e && typeof e === 'object' ? /** @type {any} */ (e).code : undefined;
  if (stage === 'write') {
    if (typeof code !== 'string' || DENIED_CODES.has(code)) return 'write_denied';
    return 'io_error';
  }
  if (stage === 'relay') return 'relay_error';
  if (stage === 'open') return 'open_failed';
  return 'keystore_error';
}

/**
 * A drain instance: its own single-flight promise, gone set and 429 deferrals.
 * @param {DrainDeps} [defaults]
 */
function createDrain(defaults = {}) {
  /** @type {Promise<DrainResult> | null} */
  let inFlight = null;
  /** @type {Set<string>} */
  const gone = new Set();
  /** @type {Map<string, number>} boxId -> epoch ms before which the box is not polled */
  const deferredUntil = new Map();
  /** @type {DrainRelay | null} */
  let lazyRelay = null;
  /** @type {Map<string, number>} projectCwd -> epoch ms of the last prune attempt */
  const lastPruneAt = new Map();

  /** @param {DrainDeps} deps */
  function resolveDeps(deps) {
    const d = { ...defaults, ...(deps || {}) };
    const relay = d.relay || (lazyRelay = lazyRelay || defaultRelay());
    return {
      relay,
      keystore: d.keystore || /** @type {DrainKeystore} */ (require('./feedbackBoxKeys.cjs')),
      inbox: d.inbox || /** @type {DrainInbox} */ (require('./siteFeedbackInbox.cjs')),
      now: d.now || Date.now,
      cwdExists: d.cwdExists || defaultCwdExists,
      feedbackInboxDays: d.feedbackInboxDays || defaultFeedbackInboxDays,
      log: d.log || defaultLog,
    };
  }

  /**
   * Classify a relay failure. Returns 'gone' for 404 box_not_found, else 'stop'.
   * @param {string} boxId
   * @param {RelayFailure} fail
   * @param {ReturnType<typeof resolveDeps>} d
   * @returns {'gone' | 'stop'}
   */
  function onRelayFailure(boxId, fail, d) {
    if (fail.status === 404 && fail.error === 'box_not_found') {
      gone.add(boxId);
      d.log(`box ${boxId} is gone on the relay (box_not_found)`);
      return 'gone';
    }
    if (fail.status === 429) {
      const sec = typeof fail.retryAfterSec === 'number' && fail.retryAfterSec >= 0
        ? fail.retryAfterSec : DEFAULT_RETRY_AFTER_SEC;
      deferredUntil.set(boxId, d.now() + sec * 1000);
      d.log(`box ${boxId} rate limited; deferred ${sec}s`);
      return 'stop';
    }
    d.log(`box ${boxId} stopped for this pass (${fail.status} ${safeCode(fail.error)})`);
    return 'stop';
  }

  /**
   * @param {DrainBox} box
   * @param {Record<string, unknown>} privateKeyJwk
   * @param {ReturnType<typeof resolveDeps>} d
   * @param {DrainResult} result
   * @param {{ stage: DrainStage }} ctx  updated before each step so a throw can be classified
   */
  async function drainBox(box, privateKeyJwk, d, result, ctx) {
    const { boxId, projectCwd: cwd } = box;
    /** @type {Set<string>} */
    const handled = new Set();
    for (let page = 0; page < MAX_PAGES_PER_BOX; page++) {
      ctx.stage = 'relay';
      const listed = await d.relay.listEnvelopes(boxId, PAGE_LIMIT);
      if (!listed.ok) {
        if (onRelayFailure(boxId, listed, d) === 'gone') result.goneBoxes.push(boxId);
        return;
      }
      const fresh = listed.envelopes.filter((e) => e && typeof e.envelopeId === 'string' && !handled.has(e.envelopeId));
      if (fresh.length === 0) return;
      for (const env of fresh) {
        handled.add(env.envelopeId);
        ctx.stage = 'relay';
        const got = await d.relay.getEnvelope(boxId, env.envelopeId);
        if (!got.ok) {
          if (got.status === 404 && got.error === 'envelope_not_found') continue;
          if (onRelayFailure(boxId, got, d) === 'gone') result.goneBoxes.push(boxId);
          return;
        }
        const bytes = got.body.length;
        const hostId = typeof env.hostId === 'string' ? env.hostId : '';
        const metaOk = HOST_ID_RE.test(hostId)
          && typeof env.receivedAt === 'string' && env.receivedAt.length > 0
          && typeof env.origin === 'string' && env.origin.length > 0;
        ctx.stage = 'open';
        const opened = metaOk
          ? await openReportEnvelope(got.body, { privateKeyJwk, boxId })
          : /** @type {const} */ ({ ok: false, code: 'bad_metadata' });
        ctx.stage = 'write';
        if (!opened.ok) {
          await d.inbox.appendRejected({ cwd, at: new Date(d.now()).toISOString(), boxId, hostId, code: opened.code, bytes });
          result.rejected += 1;
          d.log(`box ${boxId} rejected ${hostId || '(no host id)'} (${opened.code})`);
        } else {
          /** @type {{ duplicate: boolean, hostId: string } | null} */
          let w = null;
          let reporterVerified = verifyReporter(opened.report, null);
          if (reporterVerified !== null) {
            ctx.stage = 'keystore';
            const secret = d.keystore.getIdentitySecret ? await d.keystore.getIdentitySecret(boxId) : null;
            reporterVerified = verifyReporter(opened.report, secret);
            ctx.stage = 'write';
          }
          try {
            w = await d.inbox.writeItem({
              cwd, hostId, boxId, receivedAt: env.receivedAt, origin: env.origin,
              report: opened.report, screenshot: opened.screenshot, annotated: opened.annotated,
              reporterVerified,
            });
          } catch (e) {
            if (!isHostIdClash(e)) throw e;
          }
          if (!w) {
            await d.inbox.appendRejected({ cwd, at: new Date(d.now()).toISOString(), boxId, hostId, code: HOST_ID_CLASH, bytes });
            result.rejected += 1;
            d.log(`box ${boxId} rejected ${hostId} (${HOST_ID_CLASH})`);
          } else if (w.duplicate) result.duplicates += 1;
          else result.stored += 1;
        }
        ctx.stage = 'relay';
        const acked = await d.relay.ackEnvelope(boxId, env.envelopeId);
        if (!acked.ok) {
          if (acked.status === 404 && acked.error === 'envelope_not_found') continue;
          if (onRelayFailure(boxId, acked, d) === 'gone') result.goneBoxes.push(boxId);
          return;
        }
      }
    }
  }

  /**
   * Prune the project's feedback-inbox at most once per PRUNE_EVERY_MS. A failure is logged with
   * a fixed code and not retried until the next window.
   * @param {string} cwd
   * @param {ReturnType<typeof resolveDeps>} d
   */
  async function maybePrune(cwd, d) {
    const now = d.now();
    const last = lastPruneAt.get(cwd);
    if (last !== undefined && now - last < PRUNE_EVERY_MS) return;
    lastPruneAt.set(cwd, now);
    try {
      await d.inbox.prune(cwd, d.feedbackInboxDays());
    } catch {
      d.log('feedback-inbox prune failed (prune_failed)');
    }
  }

  /**
   * @param {DrainDeps} deps
   * @returns {Promise<DrainResult>}
   */
  async function runPass(deps) {
    const d = resolveDeps(deps);
    /** @type {DrainResult} */
    const result = { stored: 0, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] };
    /** @type {DrainBox[]} */
    let boxes;
    try {
      boxes = await d.keystore.listBoxes();
    } catch {
      d.log('could not read the box keystore');
      return result;
    }
    const known = new Set(boxes.map((b) => b.boxId));
    for (const id of [...gone]) if (!known.has(id)) gone.delete(id);
    for (const id of [...deferredUntil.keys()]) if (!known.has(id)) deferredUntil.delete(id);

    for (const box of boxes) {
      if (gone.has(box.boxId)) {
        result.goneBoxes.push(box.boxId);
        continue;
      }
      const until = deferredUntil.get(box.boxId);
      if (until !== undefined) {
        if (d.now() < until) continue;
        deferredUntil.delete(box.boxId);
      }
      if (!d.cwdExists(box.projectCwd)) {
        result.heldBoxes.push(box.boxId);
        continue;
      }
      /** @type {{ stage: DrainStage }} */
      const ctx = { stage: 'keystore' };
      try {
        const key = await d.keystore.getPrivateKey(box.boxId);
        if (!key) continue;
        await drainBox(box, key, d, result, ctx);
      } catch (e) {
        d.log(`box ${box.boxId} stopped for this pass (${classifyError(ctx.stage, e)})`);
      }
      await maybePrune(box.projectCwd, d);
    }
    return result;
  }

  /**
   * One drain pass; concurrent callers share the pass already running.
   * @param {DrainDeps} [deps]
   * @returns {Promise<DrainResult>}
   */
  function drainOnce(deps = {}) {
    if (inFlight) return inFlight;
    const p = runPass(deps).finally(() => {
      inFlight = null;
    });
    inFlight = p;
    return p;
  }

  /**
   * Run drainOnce every intervalMs on an unref'd timer.
   * @param {DrainDeps & { intervalMs?: number }} [opts]
   */
  function startDrainLoop(opts = {}) {
    const { intervalMs = DEFAULT_INTERVAL_MS, ...deps } = opts;
    const tick = () => {
      drainOnce(deps).catch(() => { /* a pass never rejects; belt and braces for the timer */ });
    };
    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return {
      drainNow: () => drainOnce(deps),
      stop: () => clearInterval(timer),
    };
  }

  return { drainOnce, startDrainLoop };
}

const defaultDrain = createDrain();

module.exports = {
  createDrain,
  drainOnce: defaultDrain.drainOnce,
  startDrainLoop: defaultDrain.startDrainLoop,
  PAGE_LIMIT,
  DEFAULT_INTERVAL_MS,
  PRUNE_EVERY_MS,
  verifyReporter,
};
