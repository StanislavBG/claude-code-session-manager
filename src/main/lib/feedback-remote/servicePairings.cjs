'use strict';

/**
 * servicePairings.cjs — store of services paired over the Web Remote relay
 * (first one: Kiln). Pure Node — no Electron — importable in unit tests.
 *
 * File (default ~/.claude/session-manager/remote-services.json, mode 0600):
 *   { version: 1, pending: [...], services: [...] }
 *
 * - pending: { pairingId, name, homeCwd, scope, createdAt, expiresAt } — a
 *   pairing the owner started; lives 10 minutes (the relay code itself lasts 5).
 * - services: { serviceId, name, homeCwd, scope, pubKey, relayClientId,
 *   pairedAt, lastSeenAt, opened: [{ epicId, at }] } — a confirmed service with
 *   its pinned P-256 public key and the ledger of Epics it opened (newest 1000).
 *
 * State is read once from disk (missing/corrupt = empty) and kept in memory;
 * every mutation is written atomically, serialized through one queue. Reads
 * are synchronous over the in-memory copy. Later PRDs use findByPubKey to
 * authenticate a service, `scope` to gate its tools, and hasOpened to limit
 * its reads to its own Epics.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { writeTextAtomic, readJsonOrSync } = require('../util/atomicFs.cjs');

const STORE_VERSION = 1;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_OPENED = 1000;
const MAX_NAME_LEN = 64;
const MAX_PUBKEY_LEN = 1024;
const MAX_EPIC_ID_LEN = 128;
const SERVICE_TOOL_NAMES = Object.freeze([
  'feedback_list_projects',
  'feedback_open_session',
  'macro_list',
  'macro_run',
  'epic_get',
  'events_read',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultFilePath() {
  const { claudeHome } = require('../scheduler/schedulerPaths.cjs');
  return path.join(claudeHome(), 'session-manager', 'remote-services.json');
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_NAME_LEN || /[\r\n]/.test(name)) {
    throw new Error(`name must be a one-line string of 1 to ${MAX_NAME_LEN} chars`);
  }
  return name;
}

function validateHomeCwd(homeCwd) {
  if (typeof homeCwd !== 'string' || homeCwd.length === 0 || !path.isAbsolute(homeCwd) || homeCwd.includes('\0')) {
    throw new Error('homeCwd must be an absolute path');
  }
  return homeCwd;
}

function validateScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) throw new Error('scope must be a non-empty list of tool names');
  for (const t of scope) {
    if (typeof t !== 'string' || !SERVICE_TOOL_NAMES.includes(t)) {
      throw new Error(`scope names an unknown tool: ${String(t)}`);
    }
  }
  return [...new Set(scope)];
}

function validateRelayClientId(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error('relayClientId must be a UUID or null');
  return v.toLowerCase();
}

function validatePubKey(pubKey) {
  if (typeof pubKey !== 'string' || pubKey.length === 0 || pubKey.length > MAX_PUBKEY_LEN) {
    throw new Error('pubKey must be a non-empty string');
  }
  return pubKey;
}

function validateEpicId(epicId) {
  if (typeof epicId !== 'string' || epicId.length === 0 || epicId.length > MAX_EPIC_ID_LEN) {
    throw new Error('epicId must be a non-empty string');
  }
  return epicId;
}

function publicService(s) {
  return {
    serviceId: s.serviceId,
    name: s.name,
    homeCwd: s.homeCwd,
    scope: [...s.scope],
    pubKey: s.pubKey,
    relayClientId: s.relayClientId,
    pairedAt: s.pairedAt,
    lastSeenAt: s.lastSeenAt,
  };
}

function publicPending(p) {
  return { pairingId: p.pairingId, name: p.name, homeCwd: p.homeCwd, scope: [...p.scope], createdAt: p.createdAt, expiresAt: p.expiresAt };
}

function normalizeLoaded(raw) {
  const empty = { version: STORE_VERSION, pending: [], services: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const pending = Array.isArray(raw.pending) ? raw.pending.filter((p) => p && typeof p.pairingId === 'string') : [];
  const services = Array.isArray(raw.services)
    ? raw.services
      .filter((s) => s && typeof s.serviceId === 'string' && typeof s.pubKey === 'string')
      .map((s) => ({ ...s, scope: Array.isArray(s.scope) ? s.scope : [], opened: Array.isArray(s.opened) ? s.opened : [] }))
    : [];
  return { version: STORE_VERSION, pending, services };
}

/**
 * @param {{ filePath?: string, now?: () => number }} [opts]
 */
function createServicePairings({ filePath, now } = {}) {
  const file = filePath || defaultFilePath();
  const clock = typeof now === 'function' ? now : () => Date.now();
  /** @type {{ version: number, pending: any[], services: any[] } | null} */
  let state = null;
  let queue = Promise.resolve();

  function load() {
    if (!state) state = normalizeLoaded(readJsonOrSync(file, null));
    return state;
  }

  function prunePending(s) {
    const t = clock();
    s.pending = s.pending.filter((p) => typeof p.expiresAt === 'number' && p.expiresAt > t);
  }

  /** Run a mutation then persist; serialized so writes never interleave. */
  function mutate(fn) {
    const run = queue.then(async () => {
      const s = load();
      const result = fn(s);
      await writeTextAtomic(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  function findService(serviceId) {
    return load().services.find((x) => x.serviceId === serviceId) || null;
  }

  return {
    createPending({ name, homeCwd, scope } = /** @type {any} */ ({})) {
      let entry;
      try {
        const t = clock();
        entry = {
          pairingId: crypto.randomUUID(),
          name: validateName(name),
          homeCwd: validateHomeCwd(homeCwd),
          scope: validateScope(scope),
          createdAt: t,
          expiresAt: t + PENDING_TTL_MS,
        };
      } catch (e) {
        return Promise.reject(e);
      }
      return mutate((s) => {
        prunePending(s);
        s.pending.push(entry);
        return { pairingId: entry.pairingId, expiresAt: entry.expiresAt };
      });
    },

    listPending() {
      const t = clock();
      return load().pending.filter((p) => p.expiresAt > t).map(publicPending);
    },

    confirmPending(pairingId, pubKey, { relayClientId = null } = {}) {
      let key;
      let relayId;
      try {
        key = validatePubKey(pubKey);
        relayId = validateRelayClientId(relayClientId);
      } catch (e) {
        return Promise.reject(e);
      }
      return mutate((s) => {
        const t = clock();
        const idx = s.pending.findIndex((p) => p.pairingId === pairingId);
        if (idx === -1) throw new Error('no pending pairing with that id');
        const p = s.pending[idx];
        if (!(p.expiresAt > t)) {
          s.pending.splice(idx, 1);
          throw new Error('pending pairing has expired');
        }
        if (s.services.some((x) => x.pubKey === key)) throw new Error('that public key is already paired');
        s.pending.splice(idx, 1);
        prunePending(s);
        const svc = {
          serviceId: crypto.randomUUID(),
          name: p.name,
          homeCwd: p.homeCwd,
          scope: [...p.scope],
          pubKey: key,
          relayClientId: relayId,
          pairedAt: t,
          lastSeenAt: t,
          opened: [],
        };
        s.services.push(svc);
        return publicService(svc);
      });
    },

    findByPubKey(pubKey) {
      if (typeof pubKey !== 'string' || pubKey.length === 0) return null;
      const s = load().services.find((x) => x.pubKey === pubKey);
      return s ? publicService(s) : null;
    },

    list() {
      return load().services.map(publicService);
    },

    revoke(serviceId) {
      return mutate((s) => {
        const before = s.services.length;
        s.services = s.services.filter((x) => x.serviceId !== serviceId);
        return s.services.length !== before;
      });
    },

    recordOpened(serviceId, epicId) {
      let id;
      try { id = validateEpicId(epicId); } catch (e) { return Promise.reject(e); }
      return mutate((s) => {
        const svc = s.services.find((x) => x.serviceId === serviceId);
        if (!svc) throw new Error('no paired service with that id');
        svc.opened = svc.opened.filter((o) => o && o.epicId !== id);
        svc.opened.push({ epicId: id, at: clock() });
        if (svc.opened.length > MAX_OPENED) svc.opened = svc.opened.slice(-MAX_OPENED);
        return true;
      });
    },

    hasOpened(serviceId, epicId) {
      const svc = findService(serviceId);
      return !!svc && svc.opened.some((o) => o && o.epicId === epicId);
    },

    touchLastSeen(serviceId) {
      return mutate((s) => {
        const svc = s.services.find((x) => x.serviceId === serviceId);
        if (!svc) return false;
        svc.lastSeenAt = clock();
        return true;
      });
    },
  };
}

module.exports = {
  createServicePairings,
  SERVICE_TOOL_NAMES,
  PENDING_TTL_MS,
  MAX_OPENED,
};
