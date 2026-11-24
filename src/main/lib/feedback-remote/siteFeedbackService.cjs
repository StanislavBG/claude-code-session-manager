// @ts-check
/**
 * siteFeedbackService — the ONE implementation of every website-feedback widget setting and
 * inbox action. The desktop UI (IPC) and the Feedback MCP (admin routes) both call these
 * functions, so the two can never disagree. Data path:
 * session-manager-operations/architecture/site-feedback.md.
 *
 * Widgets (sealed drop boxes on the bilko.run relay):
 *   createWidget / listWidgets / updateWidget / deleteWidget / getSnippet
 *   - createWidget generates the box key pair (feedbackSeal), registers the box on the relay
 *     (feedbackRelayClient) and only then stores the private key (feedbackBoxKeys).
 *   - Relay error codes are passed through verbatim as `error`, with a one-line `message`.
 * Inbox (decrypted reports in <project>/session-manager-operations/feedback-inbox/):
 *   listItems / getItem / getImage / setStatus / linkEpic delegate to siteFeedbackInbox;
 *   drainNow / startDrainLoop delegate to feedbackBoxDrain.
 *
 * Every function resolves `{ ok: true, ... }` or `{ ok: false, error, message }` and never
 * throws. Nothing here logs report text, image bytes, a private key or the device token.
 */
'use strict';

const fsp = require('node:fs/promises');

const WIDGET_SCRIPT_URL = 'https://bilko.run/projects/session-manager/widget/v1/feedback.js';
const KEY_PREFIX = 'fbk1_';
const MAX_ORIGINS = 10;
const MAX_LABEL = 80;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GONE_HINT = 'This widget no longer exists on bilko.run - create a new one';

/** One-line human explanations for the relay codes the UI and MCP pass through verbatim. */
const RELAY_ERROR_MESSAGES = Object.freeze({
  not_linked: 'This desktop is not paired with bilko.run yet - pair it in App Settings > Phone remote first',
  not_enabled: 'Website feedback is not enabled for this bilko.run account yet',
  box_limit_reached: 'This bilko.run account already has the most feedback widgets it may have - delete one first',
  device_token_required: 'Only the paired desktop can do this - the request did not carry its device token',
  rate_limited: 'bilko.run is rate limiting these requests - wait a minute and try again',
});

/**
 * @typedef {{ ok: false, error: string, message: string, status?: number, retryAfterSec?: number }} Failure
 * @typedef {{ ok: false, status: number, error: string, retryAfterSec?: number }} RelayFailure
 * @typedef {{ boxId: string, label?: string, allowedOrigins?: string[], state?: string, pending?: number }} RelayBox
 * @typedef {{
 *   createBox: (input: { label: string, publicKey: string, allowedOrigins: string[] }) => Promise<{ ok: true, boxId: string, state?: string, createdAt?: string } | RelayFailure>,
 *   listBoxes: () => Promise<{ ok: true, boxes: RelayBox[] } | RelayFailure>,
 *   patchBox: (boxId: string, patch: { label?: string, allowedOrigins?: string[], state?: 'open'|'paused' }) => Promise<{ ok: true, box: RelayBox } | RelayFailure>,
 *   deleteBox: (boxId: string) => Promise<{ ok: true } | RelayFailure>,
 *   listEnvelopes: (boxId: string, limit?: number) => Promise<any>,
 *   getEnvelope: (boxId: string, envelopeId: string) => Promise<any>,
 *   ackEnvelope: (boxId: string, envelopeId: string) => Promise<any>,
 * }} ServiceRelay
 * @typedef {import('./feedbackBoxKeys.cjs')} ServiceKeystore
 * @typedef {import('./siteFeedbackInbox.cjs')} ServiceInbox
 * @typedef {'open'|'in_progress'|'resolved'|'wontfix'} InboxStatus
 * @typedef {{ drainOnce: (deps?: any) => Promise<any>, startDrainLoop: (opts?: any) => { drainNow: () => Promise<any>, stop: () => void } }} ServiceDrain
 * @typedef {{ relay?: ServiceRelay, keystore?: ServiceKeystore, inbox?: ServiceInbox, drain?: ServiceDrain,
 *   seal?: { generateBoxKeypair: () => { publicKey: string, privateKeyJwk: object }, keyFingerprint: (pk: string) => string } }} ServiceDeps
 */

/**
 * @param {string} error
 * @param {string} [message]
 * @returns {Failure}
 */
function failure(error, message) {
  return { ok: false, error, message: message || RELAY_ERROR_MESSAGES[/** @type {keyof typeof RELAY_ERROR_MESSAGES} */ (error)] || `bilko.run refused the request (${error})` };
}

/**
 * A relay failure passed through verbatim, with its one-line explanation.
 * @param {RelayFailure} r
 * @returns {Failure}
 */
function relayFailure(r) {
  /** @type {Failure} */
  const out = { ...failure(r.error), status: r.status };
  return typeof r.retryAfterSec === 'number' ? { ...out, retryAfterSec: r.retryAfterSec } : out;
}

/** @param {unknown} e */
function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

/** @param {unknown} v @returns {v is string} */
function nonEmpty(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Normalise each origin to new URL(o).origin and drop duplicates. Only https:, or
 * http://localhost / http://127.0.0.1, and 1-10 entries.
 * @param {unknown} origins
 * @returns {{ ok: true, origins: string[] } | Failure}
 */
function normalizeOrigins(origins) {
  if (!Array.isArray(origins)) return failure('invalid_allowed_origins', 'allowedOrigins must be a list of 1-10 origins');
  /** @type {string[]} */
  const out = [];
  for (const o of origins) {
    if (typeof o !== 'string') return failure('invalid_allowed_origins', 'Every allowed origin must be a string');
    /** @type {URL} */
    let url;
    try {
      url = new URL(o.trim());
    } catch {
      return failure('invalid_allowed_origins', `Not a valid origin: ${o.slice(0, 200)}`);
    }
    const ok = url.protocol === 'https:'
      || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
    if (!ok) {
      return failure('invalid_allowed_origins', `Origin must be https, or http://localhost / http://127.0.0.1: ${o.slice(0, 200)}`);
    }
    if (!out.includes(url.origin)) out.push(url.origin);
  }
  if (out.length < 1 || out.length > MAX_ORIGINS) {
    return failure('invalid_allowed_origins', `allowedOrigins must hold 1-${MAX_ORIGINS} distinct origins`);
  }
  return { ok: true, origins: out };
}

/** @param {unknown} label @returns {{ ok: true, label: string } | Failure} */
function normalizeLabel(label) {
  const s = typeof label === 'string' ? label.trim() : '';
  if (s.length < 1 || s.length > MAX_LABEL) return failure('invalid_label', `label must be 1-${MAX_LABEL} characters`);
  return { ok: true, label: s };
}

/**
 * The one-line embed for a box.
 * @param {string} boxId
 * @param {string} fingerprint
 */
function snippetFor(boxId, fingerprint) {
  return `<script src="${WIDGET_SCRIPT_URL}" data-key="${KEY_PREFIX}${boxId}.${fingerprint}" async></script>`;
}

/** @returns {ServiceRelay} */
function defaultRelay() {
  const { createRelayClient } = require('./feedbackRelayClient.cjs');
  return createRelayClient({
    getDeviceToken: () => require('../../webRemote.cjs').getLinkedDeviceToken(),
  });
}

/**
 * A service instance. Every dependency is injectable (tests); the defaults are the real
 * relay client (paired device token), keystore, inbox and drain.
 * @param {ServiceDeps} [deps]
 */
function createSiteFeedbackService(deps = {}) {
  /** @type {ServiceRelay | null} */
  let lazyRelay = deps.relay || null;
  const relay = () => (lazyRelay = lazyRelay || defaultRelay());
  const keystore = () => deps.keystore || require('./feedbackBoxKeys.cjs');
  const inbox = () => deps.inbox || require('./siteFeedbackInbox.cjs');
  const drain = () => deps.drain || require('./feedbackBoxDrain.cjs');
  const seal = () => deps.seal || require('./feedbackSeal.cjs');
  const drainDeps = () => ({ relay: relay(), keystore: keystore(), inbox: inbox() });
  /** @type {{ drainNow: () => Promise<any>, stop: () => void } | null} */
  let loop = null;

  /** @param {string} boxId */
  async function localBox(boxId) {
    const all = await keystore().listBoxes();
    return all.find((b) => b.boxId === boxId) || null;
  }

  /**
   * @param {{ cwd: string, label: string, allowedOrigins: string[] }} p
   */
  async function createWidget(p) {
    const { cwd, label, allowedOrigins } = p || /** @type {any} */ ({});
    if (!nonEmpty(cwd)) return failure('invalid_input', 'cwd is required');
    const l = normalizeLabel(label);
    if (!l.ok) return l;
    const o = normalizeOrigins(allowedOrigins);
    if (!o.ok) return o;
    try {
      const kp = seal().generateBoxKeypair();
      const fingerprint = seal().keyFingerprint(kp.publicKey);
      const created = await relay().createBox({ label: l.label, publicKey: kp.publicKey, allowedOrigins: o.origins });
      if (!created.ok) return relayFailure(created);
      try {
        await keystore().addBox({
          boxId: created.boxId, projectCwd: cwd, label: l.label, publicKey: kp.publicKey,
          fingerprint, privateKeyJwk: /** @type {Record<string, unknown>} */ (kp.privateKeyJwk),
        });
      } catch (e) {
        // Without its private key the box could never be opened: take it back off the relay.
        await relay().deleteBox(created.boxId).catch(() => {});
        return failure('keystore_failed', `The widget key could not be saved: ${errMessage(e)}`);
      }
      return { ok: /** @type {const} */ (true), boxId: created.boxId, fingerprint, snippet: snippetFor(created.boxId, fingerprint) };
    } catch (e) {
      return failure('internal', errMessage(e));
    }
  }

  /**
   * Local records merged with relay state. A local box the relay no longer lists is 'gone'.
   * When the relay cannot be read, widgets carry state 'unknown' and `relayError` says why.
   * @param {{ cwd?: string }} [p]
   */
  async function listWidgets(p = {}) {
    try {
      const cwd = p && nonEmpty(p.cwd) ? p.cwd : undefined;
      const local = await keystore().listBoxes(cwd ? { projectCwd: cwd } : undefined);
      const remote = await relay().listBoxes();
      /** @type {Map<string, RelayBox>} */
      const byId = new Map();
      if (remote.ok) for (const b of remote.boxes) if (b && nonEmpty(b.boxId)) byId.set(b.boxId, b);
      const widgets = local.map((b) => {
        const r = byId.get(b.boxId);
        const base = {
          boxId: b.boxId,
          projectCwd: b.projectCwd,
          fingerprint: b.fingerprint,
          createdAt: b.createdAt,
          snippet: snippetFor(b.boxId, b.fingerprint),
        };
        if (!remote.ok) {
          return { ...base, label: b.label, allowedOrigins: /** @type {string[]} */ ([]), state: 'unknown', pending: null, hint: null };
        }
        if (!r) {
          return { ...base, label: b.label, allowedOrigins: /** @type {string[]} */ ([]), state: 'gone', pending: 0, hint: GONE_HINT };
        }
        return {
          ...base,
          label: typeof r.label === 'string' ? r.label : b.label,
          allowedOrigins: Array.isArray(r.allowedOrigins) ? r.allowedOrigins : [],
          state: typeof r.state === 'string' ? r.state : 'unknown',
          pending: typeof r.pending === 'number' ? r.pending : 0,
          hint: null,
        };
      });
      return remote.ok
        ? { ok: /** @type {const} */ (true), widgets }
        : { ok: /** @type {const} */ (true), widgets, relayError: relayFailure(remote) };
    } catch (e) {
      return failure('internal', errMessage(e));
    }
  }

  /**
   * @param {{ boxId: string, label?: string, allowedOrigins?: string[], state?: 'open'|'paused' }} p
   */
  async function updateWidget(p) {
    const { boxId, label, allowedOrigins, state } = p || /** @type {any} */ ({});
    if (!nonEmpty(boxId)) return failure('invalid_input', 'boxId is required');
    /** @type {{ label?: string, allowedOrigins?: string[], state?: 'open'|'paused' }} */
    const patch = {};
    if (label !== undefined) {
      const l = normalizeLabel(label);
      if (!l.ok) return l;
      patch.label = l.label;
    }
    if (allowedOrigins !== undefined) {
      const o = normalizeOrigins(allowedOrigins);
      if (!o.ok) return o;
      patch.allowedOrigins = o.origins;
    }
    if (state !== undefined) {
      if (state !== 'open' && state !== 'paused') return failure('invalid_state', "state must be 'open' or 'paused'");
      patch.state = state;
    }
    if (Object.keys(patch).length === 0) return failure('invalid_input', 'Nothing to update: give label, allowedOrigins or state');
    try {
      if (!(await localBox(boxId))) return failure('not_found', `No widget ${boxId} on this desktop`);
      const r = await relay().patchBox(boxId, patch);
      if (!r.ok) {
        if (r.status === 404 && r.error === 'box_not_found') return { ...relayFailure(r), message: GONE_HINT };
        return relayFailure(r);
      }
      const b = r.box || /** @type {RelayBox} */ ({ boxId });
      return {
        ok: /** @type {const} */ (true),
        widget: { boxId, label: b.label, allowedOrigins: b.allowedOrigins, state: b.state, pending: b.pending },
      };
    } catch (e) {
      return failure('internal', errMessage(e));
    }
  }

  /**
   * Deletes on the relay, then locally. A box the relay no longer has is removed locally too.
   * @param {{ boxId: string }} p
   */
  async function deleteWidget(p) {
    const boxId = p && p.boxId;
    if (!nonEmpty(boxId)) return failure('invalid_input', 'boxId is required');
    try {
      if (!(await localBox(boxId))) return failure('not_found', `No widget ${boxId} on this desktop`);
      const r = await relay().deleteBox(boxId);
      if (!r.ok && !(r.status === 404 && r.error === 'box_not_found')) return relayFailure(r);
      await keystore().removeBox(boxId);
      return { ok: /** @type {const} */ (true), boxId };
    } catch (e) {
      return failure('internal', errMessage(e));
    }
  }

  /** @param {{ boxId: string }} p */
  async function getSnippet(p) {
    const boxId = p && p.boxId;
    if (!nonEmpty(boxId)) return failure('invalid_input', 'boxId is required');
    try {
      const b = await localBox(boxId);
      if (!b) return failure('not_found', `No widget ${boxId} on this desktop`);
      return { ok: /** @type {const} */ (true), boxId, fingerprint: b.fingerprint, snippet: snippetFor(boxId, b.fingerprint) };
    } catch (e) {
      return failure('internal', errMessage(e));
    }
  }

  /** @param {{ cwd: string, status?: InboxStatus }} p */
  async function listItems(p) {
    const { cwd, status } = p || /** @type {any} */ ({});
    if (!nonEmpty(cwd)) return failure('invalid_input', 'cwd is required');
    try {
      return { ok: /** @type {const} */ (true), items: await inbox().list(cwd, status ? { status } : {}) };
    } catch (e) {
      return failure('invalid_input', errMessage(e));
    }
  }

  /** @param {{ cwd: string, hostId: string }} p */
  async function getItem(p) {
    const { cwd, hostId } = p || /** @type {any} */ ({});
    if (!nonEmpty(cwd)) return failure('invalid_input', 'cwd is required');
    try {
      const item = await inbox().get(cwd, hostId);
      if (!item) return failure('not_found', `No feedback item ${hostId}`);
      return { ok: /** @type {const} */ (true), item };
    } catch (e) {
      return failure('invalid_input', errMessage(e));
    }
  }

  /**
   * One stored image as a data URL, only after its bytes sniff as PNG.
   * @param {{ cwd: string, hostId: string, which?: 'screenshot'|'annotated' }} p
   */
  async function getImage(p) {
    const { cwd, hostId, which = 'annotated' } = p || /** @type {any} */ ({});
    if (!nonEmpty(cwd)) return failure('invalid_input', 'cwd is required');
    if (which !== 'screenshot' && which !== 'annotated') return failure('invalid_input', "which must be 'screenshot' or 'annotated'");
    try {
      const item = await inbox().get(cwd, hostId);
      if (!item) return failure('not_found', `No feedback item ${hostId}`);
      const file = item.imagePaths[/** @type {'screenshot'|'annotated'} */ (which)];
      if (!file) return failure('not_found', `Feedback item ${hostId} has no ${which} image`);
      const buf = await fsp.readFile(file);
      if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return failure('not_png', `The stored ${which} image is not a PNG`);
      }
      return { ok: /** @type {const} */ (true), hostId, which, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
    } catch (e) {
      return failure('invalid_input', errMessage(e));
    }
  }

  /** @param {{ cwd: string, hostId: string, status: InboxStatus, note?: string | null }} p */
  async function setStatus(p) {
    const { cwd, hostId, status, note } = p || /** @type {any} */ ({});
    if (!nonEmpty(cwd)) return failure('invalid_input', 'cwd is required');
    try {
      return { ok: /** @type {const} */ (true), meta: await inbox().setStatus(cwd, hostId, status, note ?? null) };
    } catch (e) {
      const msg = errMessage(e);
      return failure(/no item/.test(msg) ? 'not_found' : 'invalid_input', msg);
    }
  }

  /** @param {{ cwd: string, hostId: string, epicId: string }} p */
  async function linkEpic(p) {
    const { cwd, hostId, epicId } = p || /** @type {any} */ ({});
    if (!nonEmpty(cwd)) return failure('invalid_input', 'cwd is required');
    try {
      return { ok: /** @type {const} */ (true), meta: await inbox().linkEpic(cwd, hostId, epicId) };
    } catch (e) {
      const msg = errMessage(e);
      return failure(/no item/.test(msg) ? 'not_found' : 'invalid_input', msg);
    }
  }

  /** Delete one stored item (its report, images and meta). @param {{ cwd: string, hostId: string }} p */
  async function removeItem(p) {
    const { cwd, hostId } = p || /** @type {any} */ ({});
    if (!nonEmpty(cwd)) return failure('invalid_input', 'cwd is required');
    try {
      const r = await inbox().remove(cwd, hostId);
      if (!r.removed) return failure('not_found', `No feedback item ${hostId}`);
      return { ok: /** @type {const} */ (true), hostId };
    } catch (e) {
      return failure('invalid_input', errMessage(e));
    }
  }

  /** One drain pass now (shares a pass already running). */
  async function drainNow() {
    try {
      const result = loop ? await loop.drainNow() : await drain().drainOnce(drainDeps());
      return { ok: /** @type {const} */ (true), ...result };
    } catch (e) {
      return failure('internal', errMessage(e));
    }
  }

  /**
   * Start the periodic drain once (idempotent).
   * @param {{ intervalMs?: number }} [opts]
   */
  function startDrainLoop(opts = {}) {
    if (!loop) loop = drain().startDrainLoop({ ...drainDeps(), ...(opts || {}) });
    return loop;
  }

  function stopDrainLoop() {
    if (loop) loop.stop();
    loop = null;
  }

  return {
    createWidget, listWidgets, updateWidget, deleteWidget, getSnippet,
    listItems, getItem, getImage, setStatus, linkEpic, removeItem, drainNow,
    startDrainLoop, stopDrainLoop,
  };
}

const defaultService = createSiteFeedbackService();

module.exports = {
  ...defaultService,
  createSiteFeedbackService,
  normalizeOrigins,
  snippetFor,
  RELAY_ERROR_MESSAGES,
  GONE_HINT,
  WIDGET_SCRIPT_URL,
};
