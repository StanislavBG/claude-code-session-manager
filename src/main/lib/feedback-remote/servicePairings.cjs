'use strict';

/**
 * servicePairings.cjs — store of services paired over the Web Remote relay
 * (first one: Kiln). Pure Node — no Electron — importable in unit tests.
 *
 * File (default ~/.claude/session-manager/remote-services.json, mode 0600):
 *   { version: 1, pending: [...], services: [...] }
 *
 * - pending: { pairingId, name, homeCwd, scope, projectRoot, createdAt, expiresAt } — a
 *   pairing the owner started; lives 10 minutes (the relay code itself lasts 5).
 * - services: { serviceId, name, homeCwd, scope, projectRoot, pubKey, relayClientId,
 *   pairedAt, lastSeenAt, opened: [{ cwd, epicId, externalRef?, at }] } — a
 *   confirmed service with its pinned P-256 public key and the ledger of Epics
 *   it opened (newest 1000), each keyed by project + id: an Epic id matches
 *   only in the project the service opened it in.
 * - projectRoot: the owner-approved projects folder project_create creates
 *   into — required when scope grants project_create, null otherwise (and for
 *   a record saved before the field existed).
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
const MAX_EXTERNAL_REF_LEN = 200;
const SERVICE_TOOL_NAMES = Object.freeze([
  'feedback_list_projects',
  'feedback_open_session',
  'macro_list',
  'macro_run',
  'epic_get',
  'events_read',
  'project_create',
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

/** Required (absolute, no NUL, resolved) when the scope grants project_create; null otherwise. */
function validateProjectRoot(projectRoot, scope) {
  if (!scope.includes('project_create')) return null;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || !path.isAbsolute(projectRoot) || projectRoot.includes('\0')) {
    throw new Error('projectRoot must be an absolute path when scope includes project_create');
  }
  return path.resolve(projectRoot);
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

function validateLedgerCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || !path.isAbsolute(cwd) || cwd.includes('\0')) {
    throw new Error('cwd must be an absolute path');
  }
  return path.resolve(cwd);
}

function validateExternalRef(externalRef) {
  if (externalRef === undefined || externalRef === null || externalRef === '') return null;
  if (typeof externalRef !== 'string' || externalRef.length > MAX_EXTERNAL_REF_LEN) {
    throw new Error('externalRef must be a string');
  }
  return externalRef;
}

const PAIRED_VIA = ['window', 'local'];
const START_WORK_ALL = '*';
const MAX_START_WORK_TARGETS = 200;

/** Owner grant targets: absolute cwds (resolved) or '*'. Throws on anything else. */
function validateStartWorkTargets(targets) {
  if (!Array.isArray(targets) || targets.length > MAX_START_WORK_TARGETS) {
    throw new Error(`targets must be a list of at most ${MAX_START_WORK_TARGETS} project paths or '*'`);
  }
  const out = [];
  for (const t of targets) {
    let n;
    if (t === START_WORK_ALL) n = START_WORK_ALL;
    else if (typeof t === 'string' && t.length > 0 && path.isAbsolute(t) && !t.includes('\0')) n = path.resolve(t);
    else throw new Error(`target must be an absolute project path or '*': ${String(t)}`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The stored startWork { targets } read back leniently: absent/invalid = off (null). */
function startWorkOf(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.targets)) return null;
  try {
    const targets = validateStartWorkTargets(raw.targets);
    return targets.length ? { targets } : null;
  } catch { return null; }
}

function publicService(s) {
  return {
    serviceId: s.serviceId,
    name: s.name,
    homeCwd: s.homeCwd,
    scope: [...s.scope],
    projectRoot: typeof s.projectRoot === 'string' ? s.projectRoot : null,
    pubKey: s.pubKey,
    relayClientId: s.relayClientId,
    pairedAt: s.pairedAt,
    lastSeenAt: s.lastSeenAt,
    pairedVia: s.pairedVia === 'local' ? 'local' : 'window',
    startWork: startWorkOf(s.startWork),
  };
}

function publicPending(p) {
  return {
    pairingId: p.pairingId,
    name: p.name,
    homeCwd: p.homeCwd,
    scope: [...p.scope],
    projectRoot: typeof p.projectRoot === 'string' ? p.projectRoot : null,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    pairedVia: p.pairedVia === 'local' ? 'local' : 'window',
  };
}

function normalizeLoaded(raw) {
  const empty = { version: STORE_VERSION, pending: [], services: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const rootOf = (x) => (typeof x.projectRoot === 'string' && x.projectRoot !== '' ? x.projectRoot : null);
  const pending = Array.isArray(raw.pending)
    ? raw.pending.filter((p) => p && typeof p.pairingId === 'string').map((p) => ({ ...p, projectRoot: rootOf(p) }))
    : [];
  const services = Array.isArray(raw.services)
    ? raw.services
      .filter((s) => s && typeof s.serviceId === 'string' && typeof s.pubKey === 'string')
      .map((s) => ({
        ...s,
        scope: Array.isArray(s.scope) ? s.scope : [],
        projectRoot: rootOf(s),
        opened: Array.isArray(s.opened) ? s.opened : [],
      }))
    : [];
  return { version: STORE_VERSION, pending, services };
}

/** True iff the service's startWork grant covers `toCwd` ('*' or its resolved cwd). */
function startWorkAllows(service, toCwd) {
  const grant = startWorkOf(service && service.startWork);
  if (!grant || typeof toCwd !== 'string' || !path.isAbsolute(toCwd)) return false;
  return grant.targets.includes(START_WORK_ALL) || grant.targets.includes(path.resolve(toCwd));
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
    createPending({ name, homeCwd, scope, projectRoot, pairedVia = 'window' } = /** @type {any} */ ({})) {
      let entry;
      try {
        const t = clock();
        if (!PAIRED_VIA.includes(pairedVia)) throw new Error(`pairedVia must be one of: ${PAIRED_VIA.join(', ')}`);
        const grants = validateScope(scope);
        entry = {
          pairingId: crypto.randomUUID(),
          name: validateName(name),
          homeCwd: validateHomeCwd(homeCwd),
          scope: grants,
          projectRoot: validateProjectRoot(projectRoot, grants),
          pairedVia,
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
          projectRoot: typeof p.projectRoot === 'string' ? p.projectRoot : null,
          pubKey: key,
          relayClientId: relayId,
          pairedAt: t,
          lastSeenAt: t,
          pairedVia: p.pairedVia === 'local' ? 'local' : 'window',
          opened: [],
        };
        s.services.push(svc);
        return publicService(svc);
      });
    },

    /** Drop a pending pairing so it can no longer be confirmed or listed. Resolves true if it existed. */
    cancelPending(pairingId) {
      if (typeof pairingId !== 'string' || pairingId.length === 0) return Promise.resolve(false);
      return mutate((s) => {
        const before = s.pending.length;
        s.pending = s.pending.filter((p) => p.pairingId !== pairingId);
        const removed = s.pending.length !== before;
        prunePending(s);
        return removed;
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

    recordOpened(serviceId, entry) {
      let cwd, id, externalRef;
      try {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('entry must be { cwd, epicId, externalRef? }');
        cwd = validateLedgerCwd(entry.cwd);
        id = validateEpicId(entry.epicId);
        externalRef = validateExternalRef(entry.externalRef);
      } catch (e) { return Promise.reject(e); }
      return mutate((s) => {
        const svc = s.services.find((x) => x.serviceId === serviceId);
        if (!svc) throw new Error('no paired service with that id');
        svc.opened = svc.opened.filter((o) => o && !(o.epicId === id && o.cwd === cwd));
        const rec = { cwd, epicId: id, at: clock() };
        if (externalRef !== null) rec.externalRef = externalRef;
        svc.opened.push(rec);
        if (svc.opened.length > MAX_OPENED) svc.opened = svc.opened.slice(-MAX_OPENED);
        return true;
      });
    },

    hasOpened(serviceId, cwd, epicId) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof epicId !== 'string' || epicId === '') return false;
      const want = path.resolve(cwd);
      const svc = findService(serviceId);
      return !!svc && svc.opened.some((o) => o && o.epicId === epicId && o.cwd === want);
    },

    /** Owner grant: auto-start work this service opens in `targets` (cwds or '*'). [] removes it. */
    setStartWork(serviceId, targets) {
      let list;
      try { list = validateStartWorkTargets(targets); } catch (e) { return Promise.reject(e); }
      return mutate((s) => {
        const svc = s.services.find((x) => x.serviceId === serviceId);
        if (!svc) throw new Error('no paired service with that id');
        if (list.length === 0) delete svc.startWork; else svc.startWork = { targets: list };
        return publicService(svc);
      });
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
  startWorkAllows,
  SERVICE_TOOL_NAMES,
  PENDING_TTL_MS,
  MAX_OPENED,
};
