// @ts-check
/**
 * feedbackRelayClient — the desktop's REST client for the bilko.run relay's sealed drop-box routes
 * ("Host contract v1" in session-manager-operations/architecture/site-feedback.md).
 *
 * Authenticates with the device token the bilko.run pairing stored (webRemote.getLinkedDeviceToken),
 * independent of `remoteEnabled`: website feedback is a separate capability from remote control.
 *
 * Every method resolves to `{ ok: true, ... }` or `{ ok: false, status, error, retryAfterSec? }` and
 * never throws. `error` is the host's `{ error }` code verbatim; transport failures use
 * `network_error` / `timeout` (status 0); no token at all is `not_linked` (status 0, no request).
 * The device token never appears in a returned value.
 */
'use strict';

const DEFAULT_BASE_URL = 'https://bilko.run';
const API_PREFIX = '/api/sm-relay';
const TIMEOUT_MS = 15000;

/**
 * @typedef {{ ok: false, status: number, error: string, retryAfterSec?: number }} RelayFailure
 * @typedef {{ label: string, publicKey: string, allowedOrigins: string[] }} CreateBoxInput
 * @typedef {{ label?: string, allowedOrigins?: string[], state?: 'open'|'paused' }} PatchBoxInput
 * @typedef {{ baseUrl?: string, getDeviceToken: () => (string|null|undefined|Promise<string|null|undefined>),
 *   fetchImpl?: typeof fetch, timeoutMs?: number }} RelayClientOptions
 */

/** @param {string|null} header @returns {number|undefined} */
function parseRetryAfter(header) {
  if (!header) return undefined;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const at = Date.parse(s);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** @param {unknown} code */
function safeCode(code) {
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : null;
}

/** @param {RelayClientOptions} opts */
function createRelayClient(opts) {
  const { baseUrl = DEFAULT_BASE_URL, getDeviceToken, fetchImpl, timeoutMs = TIMEOUT_MS } = opts || /** @type {any} */ ({});
  const apiBase = String(baseUrl).replace(/\/+$/, '') + API_PREFIX;

  /** @returns {Promise<string|null>} */
  async function token() {
    try {
      const t = typeof getDeviceToken === 'function' ? await getDeviceToken() : null;
      return typeof t === 'string' && t.length > 0 ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} method
   * @param {string} path already URL-encoded, starting with '/'
   * @param {{ json?: unknown, binary?: boolean }} [o]
   * @returns {Promise<{ ok: true, status: number, data: any } | RelayFailure>}
   */
  async function request(method, path, o = {}) {
    const tok = await token();
    if (!tok) return { ok: false, status: 0, error: 'not_linked' };
    /** @type {Record<string, string>} */
    const headers = { Authorization: `Bearer ${tok}`, Accept: o.binary ? 'application/octet-stream' : 'application/json' };
    /** @type {RequestInit} */
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (o.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.json);
    }
    let res;
    try {
      res = await (fetchImpl || fetch)(apiBase + path, init);
    } catch (e) {
      const name = e && typeof e === 'object' ? /** @type {{ name?: string }} */ (e).name : '';
      return { ok: false, status: 0, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error' };
    }
    try {
      if (!res.ok) {
        let code = null;
        try {
          const body = await res.json();
          code = safeCode(body && typeof body === 'object' ? /** @type {{ error?: unknown }} */ (body).error : null);
        } catch {
          /* non-JSON error body */
        }
        /** @type {RelayFailure} */
        const fail = { ok: false, status: res.status, error: code || `http_${res.status}` };
        if (res.status === 429) {
          const ra = parseRetryAfter(res.headers.get('retry-after'));
          if (ra !== undefined) fail.retryAfterSec = ra;
        }
        return fail;
      }
      if (o.binary) return { ok: true, status: res.status, data: Buffer.from(await res.arrayBuffer()) };
      const text = await res.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          return { ok: false, status: res.status, error: 'invalid_response' };
        }
      }
      return { ok: true, status: res.status, data };
    } catch (e) {
      const name = e && typeof e === 'object' ? /** @type {{ name?: string }} */ (e).name : '';
      return { ok: false, status: 0, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error' };
    }
  }

  const seg = (/** @type {unknown} */ s) => encodeURIComponent(String(s));

  return {
    /** @param {CreateBoxInput} input */
    async createBox(input) {
      const r = await request('POST', '/boxes', { json: input });
      if (!r.ok) return r;
      return { ok: /** @type {const} */ (true), boxId: r.data.boxId, state: r.data.state, createdAt: r.data.createdAt };
    },
    async listBoxes() {
      const r = await request('GET', '/boxes');
      if (!r.ok) return r;
      return { ok: /** @type {const} */ (true), boxes: Array.isArray(r.data.boxes) ? r.data.boxes : [] };
    },
    /** @param {string} boxId @param {PatchBoxInput} patch */
    async patchBox(boxId, patch) {
      const r = await request('PATCH', `/boxes/${seg(boxId)}`, { json: patch || {} });
      if (!r.ok) return r;
      return { ok: /** @type {const} */ (true), box: r.data };
    },
    /** @param {string} boxId */
    async deleteBox(boxId) {
      const r = await request('DELETE', `/boxes/${seg(boxId)}`);
      if (!r.ok) return r;
      return { ok: /** @type {const} */ (true) };
    },
    /** @param {string} boxId @param {number} [limit] */
    async listEnvelopes(boxId, limit) {
      const q = limit === undefined || limit === null ? '' : `?limit=${seg(limit)}`;
      const r = await request('GET', `/boxes/${seg(boxId)}/envelopes${q}`);
      if (!r.ok) return r;
      return { ok: /** @type {const} */ (true), envelopes: Array.isArray(r.data.envelopes) ? r.data.envelopes : [] };
    },
    /** @param {string} boxId @param {string} envelopeId */
    async getEnvelope(boxId, envelopeId) {
      const r = await request('GET', `/boxes/${seg(boxId)}/envelopes/${seg(envelopeId)}`, { binary: true });
      if (!r.ok) return r;
      return { ok: /** @type {const} */ (true), body: /** @type {Buffer} */ (r.data) };
    },
    /** @param {string} boxId @param {string} envelopeId */
    async ackEnvelope(boxId, envelopeId) {
      const r = await request('DELETE', `/boxes/${seg(boxId)}/envelopes/${seg(envelopeId)}`);
      if (!r.ok) return r;
      return { ok: /** @type {const} */ (true) };
    },
  };
}

module.exports = { createRelayClient, DEFAULT_BASE_URL, API_PREFIX, TIMEOUT_MS };
