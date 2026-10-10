'use strict';

// Desktop credential for acting as a 'browser'-role relay client against
// bilko.run's sm-relay client endpoints. Pairs with a one-time client code,
// stores the long-lived client token at 0600, and exchanges it for one-time WS
// tickets and the owner's device list. No Electron imports.

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { claudeHome } = require('./schedulerPaths.cjs');
const { writeJsonAtomicSync, readJsonOrSync } = require('./atomicFs.cjs');

const RELAY_CLIENT_API_BASE = 'https://bilko.run/api/sm-relay';
const REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_NAME_MAX = 64;

/** Default transport: resolves { status, json }; never includes headers in errors. */
function defaultRequest({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { reject(new Error('invalid_url')); return; }
    if (parsed.protocol !== 'https:') {
      reject(new Error('Only https:// allowed for relay API calls'));
      return;
    }
    const outHeaders = { ...headers };
    if (body != null) outHeaders['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: outHeaders,
      rejectUnauthorized: true,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (err) => reject(new Error(err.message)));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
    if (body != null) req.write(body);
    req.end();
  });
}

function defaultTokenPath() {
  return path.join(claudeHome(), 'session-manager', 'relay-client.json');
}

function createRelayClientAuth({ tokenPath, request = defaultRequest } = {}) {
  const file = tokenPath || defaultTokenPath();

  function readStored() {
    const data = readJsonOrSync(file, null);
    return data && typeof data.clientToken === 'string' && data.clientToken ? data : null;
  }
  function clearToken() {
    fs.rmSync(file, { force: true });
  }
  function isPaired() { return readStored() !== null; }
  function getClientId() { return readStored()?.clientId ?? null; }

  async function pair(code, clientName) {
    const body = { code: String(code ?? '').trim().toUpperCase() };
    const name = typeof clientName === 'string' ? clientName.slice(0, CLIENT_NAME_MAX) : '';
    if (name) body.clientName = name;
    const res = await request({
      method: 'POST',
      url: `${RELAY_CLIENT_API_BASE}/client-pair`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = res.json || {};
    if (res.status === 404) return { ok: false, error: 'relay_client_auth_unavailable' };
    if (res.status !== 200) return { ok: false, error: json.error || `HTTP ${res.status}` };
    if (!json.clientToken) return { ok: false, error: 'relay_auth_failed' };
    writeJsonAtomicSync(file, {
      clientToken: json.clientToken,
      clientId: json.clientId,
      pairedAt: new Date().toISOString(),
    }, { mode: 0o600 });
    return { ok: true, clientId: json.clientId };
  }

  /** Authenticated call; maps status codes to the module's error vocabulary. */
  async function authed(method, route, body) {
    const stored = readStored();
    if (!stored) throw new Error('relay_client_unpaired');
    const headers = { Authorization: `Bearer ${stored.clientToken}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    const res = await request({ method, url: `${RELAY_CLIENT_API_BASE}${route}`, headers, body });
    if (res.status === 401) {
      clearToken();
      throw new Error('relay_client_unpaired');
    }
    if (res.status === 404) throw new Error('relay_client_auth_unavailable');
    if (res.status < 200 || res.status >= 300) {
      throw new Error((res.json && res.json.error) || `HTTP ${res.status}`);
    }
    return res.json || {};
  }

  // Optional peer argument is accepted and ignored (remoteClient passes it).
  async function getBrowserTicket(_peer) {
    const json = await authed('POST', '/client-ticket', '{}');
    if (!json.ticket) throw new Error('relay_auth_failed');
    return json.ticket;
  }

  async function listDevices() {
    const json = await authed('GET', '/client/devices');
    return Array.isArray(json.devices) ? json.devices : [];
  }

  async function getDevicePubKey(deviceId) {
    const devices = await listDevices();
    const hit = devices.find((d) => d && d.deviceId === deviceId);
    if (!hit) throw new Error('device_not_found');
    return hit.devicePubKey;
  }

  return { pair, getBrowserTicket, getDevicePubKey, listDevices, isPaired, getClientId, clearToken };
}

const relayClientAuth = createRelayClientAuth();

module.exports = { createRelayClientAuth, relayClientAuth, RELAY_CLIENT_API_BASE };
