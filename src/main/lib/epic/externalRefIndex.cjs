'use strict';

/**
 * externalRefIndex.cjs — machine-level index from (project cwd, externalRef)
 * to the Epic an earlier handoff created, so a repeat handoff still finds that
 * Epic after it completes and leaves the project's active index.
 *
 * File: externalRefIndexPath() (schedulerHome()/external-refs.json)
 *   { version: 1, refs: { "<cwd>\0<ref>": { epicId, at, producer?, fromCwd?, macroId? } } }
 * The key is built the same way macroAdminRoutes.cjs builds its run keys.
 * cwd is used exactly as given — callers pass the resolved absolute project cwd.
 *
 * A missing, empty or corrupt file reads as empty and is replaced by the next
 * record. Writes are serialized through one in-module promise chain; the lock
 * is an in-memory Map — every caller lives in the one Electron main process.
 */

const { writeJsonAtomic, readJsonOr } = require('../util/atomicFs.cjs');
const { externalRefIndexPath } = require('../scheduler/schedulerPaths.cjs');
const { readActiveIndex } = require('./epicMint.cjs');

const VERSION = 1;

function refKey(cwd, externalRef) {
  return `${cwd}\u0000${externalRef}`;
}

function validKey(cwd, externalRef) {
  return typeof cwd === 'string' && cwd !== '' && typeof externalRef === 'string' && externalRef !== '';
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

async function readIndexFile() {
  const parsed = await readJsonOr(externalRefIndexPath(), null);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.refs)) return { version: VERSION, refs: {} };
  return { version: VERSION, refs: { ...parsed.refs } };
}

function cleanEntry({ epicId, at, producer, fromCwd, macroId }) {
  /** @type {Record<string, string>} */
  const entry = { epicId, at };
  if (typeof producer === 'string' && producer) entry.producer = producer;
  if (typeof fromCwd === 'string' && fromCwd) entry.fromCwd = fromCwd;
  if (typeof macroId === 'string' && macroId) entry.macroId = macroId;
  return entry;
}

/** Tail of the serialized write chain; never rejects. */
let writeChain = Promise.resolve();

/**
 * Record (or overwrite) the Epic for (cwd, externalRef). Resolves to the stored entry.
 */
function recordExternalRef({ cwd, externalRef, epicId, producer, fromCwd, macroId }) {
  if (!validKey(cwd, externalRef)) return Promise.reject(new TypeError('recordExternalRef: cwd and externalRef must be non-empty strings'));
  if (typeof epicId !== 'string' || !epicId) return Promise.reject(new TypeError('recordExternalRef: epicId must be a non-empty string'));
  const run = writeChain.then(async () => {
    const index = await readIndexFile();
    const entry = cleanEntry({ epicId, at: new Date().toISOString(), producer, fromCwd, macroId });
    index.refs[refKey(cwd, externalRef)] = entry;
    await writeJsonAtomic(externalRefIndexPath(), index);
    return { ...entry };
  });
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** The stored entry for (cwd, externalRef), or null. Waits for pending records. */
async function lookupExternalRef({ cwd, externalRef }) {
  if (!validKey(cwd, externalRef)) return null;
  await writeChain;
  const index = await readIndexFile();
  const entry = index.refs[refKey(cwd, externalRef)];
  if (!isPlainObject(entry) || typeof entry.epicId !== 'string' || !entry.epicId) return null;
  return { ...entry };
}

/**
 * The Epic for (cwd, externalRef) plus `open` (still in the active index), or
 * null. On an index miss, scans the project's open sessions for
 * source.externalRef === externalRef and records the hit.
 */
async function findEpicByExternalRef({ cwd, externalRef }) {
  if (!validKey(cwd, externalRef)) return null;
  const sessions = readActiveIndex(cwd).sessions;
  const entry = await lookupExternalRef({ cwd, externalRef });
  if (entry) return { ...entry, open: Object.prototype.hasOwnProperty.call(sessions, entry.epicId) };
  for (const [epicId, session] of Object.entries(sessions)) {
    const source = isPlainObject(session) && isPlainObject(session.source) ? session.source : null;
    if (!source || source.externalRef !== externalRef) continue;
    const recorded = await recordExternalRef({
      cwd,
      externalRef,
      epicId,
      producer: source.producer,
      fromCwd: source.fromCwd,
      macroId: source.macroId,
    });
    return { ...recorded, open: true };
  }
  return null;
}

/** key -> tail promise of the callers queued on that key (never rejects). */
const locks = new Map();

/**
 * Run async `fn` so calls with the same (cwd, externalRef) never overlap.
 * Different keys run concurrently. fn's result or rejection passes through.
 */
async function withExternalRefLock({ cwd, externalRef }, fn) {
  const key = refKey(cwd, externalRef);
  const prev = locks.get(key) || Promise.resolve();
  /** @type {() => void} */
  let release = () => {};
  const mine = new Promise((resolve) => { release = () => resolve(undefined); });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

module.exports = {
  recordExternalRef,
  lookupExternalRef,
  findEpicByExternalRef,
  withExternalRefLock,
};
