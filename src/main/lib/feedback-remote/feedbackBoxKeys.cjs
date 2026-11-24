// @ts-check
/**
 * feedbackBoxKeys — machine-local store mapping each feedback widget box to its project and
 * private key.
 *
 * Only this desktop can decrypt its boxes' sealed reports, so every box's private JWK lives in ONE
 * 0600 file outside every project tree: <schedulerHome>/feedback-boxes.json. Writes go through
 * util/atomicFs.cjs inside a serialized read-modify-write queue; a missing or corrupt file reads as
 * empty. listBoxes() never returns a private key — only getPrivateKey(boxId) does.
 */
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const atomicFs = require('../util/atomicFs.cjs');
const schedulerPaths = require('../scheduler/schedulerPaths.cjs');

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;

/**
 * @typedef {Record<string, unknown>} PrivateKeyJwk
 * @typedef {{ boxId: string, projectCwd: string, label: string, publicKey: string,
 *   fingerprint: string, createdAt: number }} BoxRecord
 * @typedef {BoxRecord & { privateKeyJwk: PrivateKeyJwk }} StoredBox
 * @typedef {{ boxId: string, projectCwd: string, label?: string, publicKey: string,
 *   fingerprint: string, privateKeyJwk: PrivateKeyJwk, createdAt?: number }} AddBoxInput
 */

function storeFile() {
  return path.join(schedulerPaths.schedulerHome(), 'feedback-boxes.json');
}

/** @param {unknown} v @returns {v is string} */
function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** @param {unknown} raw @returns {raw is StoredBox} */
function isStoredBox(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (raw);
  return nonEmptyString(r.boxId) && nonEmptyString(r.projectCwd) && nonEmptyString(r.publicKey)
    && nonEmptyString(r.fingerprint) && !!r.privateKeyJwk && typeof r.privateKeyJwk === 'object';
}

/** @param {string} file @returns {Promise<StoredBox[]>} */
async function readBoxes(file) {
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (data && Array.isArray(data.boxes)) return data.boxes.filter(isStoredBox);
  } catch { /* missing or corrupt reads as empty */ }
  return [];
}

/** @param {StoredBox} b @returns {BoxRecord} */
function publicRecord(b) {
  return {
    boxId: b.boxId,
    projectCwd: b.projectCwd,
    label: typeof b.label === 'string' ? b.label : '',
    publicKey: b.publicKey,
    fingerprint: b.fingerprint,
    createdAt: typeof b.createdAt === 'number' ? b.createdAt : 0,
  };
}

/** @type {Promise<unknown>} */
let writeQueue = Promise.resolve();
/**
 * Serialized read-modify-write: each mutation reads the freshest on-disk boxes.
 * @template T
 * @param {(boxes: StoredBox[]) => { boxes: StoredBox[], result: T }} mutate
 * @returns {Promise<T>}
 */
function mutateStore(mutate) {
  const file = storeFile();
  const run = async () => {
    const { boxes, result } = mutate(await readBoxes(file));
    await atomicFs.writeJsonAtomic(file, { schemaVersion: SCHEMA_VERSION, boxes }, { mode: FILE_MODE });
    return result;
  };
  const tail = writeQueue.then(run, run);
  writeQueue = tail.then(() => {}, () => {});
  return tail;
}

/**
 * Records a new box. Throws on malformed input or an existing boxId (a key is never overwritten).
 * @param {AddBoxInput} input
 * @returns {Promise<BoxRecord>}
 */
function addBox(input) {
  const src = input || /** @type {AddBoxInput} */ ({});
  if (!nonEmptyString(src.boxId)) return Promise.reject(new Error('boxId is required'));
  if (!nonEmptyString(src.projectCwd)) return Promise.reject(new Error('projectCwd is required'));
  if (!nonEmptyString(src.publicKey)) return Promise.reject(new Error('publicKey is required'));
  if (!nonEmptyString(src.fingerprint)) return Promise.reject(new Error('fingerprint is required'));
  if (!src.privateKeyJwk || typeof src.privateKeyJwk !== 'object') {
    return Promise.reject(new Error('privateKeyJwk is required'));
  }
  /** @type {StoredBox} */
  const box = {
    boxId: src.boxId,
    projectCwd: src.projectCwd,
    label: typeof src.label === 'string' ? src.label : '',
    publicKey: src.publicKey,
    fingerprint: src.fingerprint,
    privateKeyJwk: src.privateKeyJwk,
    createdAt: typeof src.createdAt === 'number' ? src.createdAt : Date.now(),
  };
  return mutateStore((boxes) => {
    if (boxes.some((b) => b.boxId === box.boxId)) throw new Error(`box ${box.boxId} already exists`);
    return { boxes: [...boxes, box], result: publicRecord(box) };
  });
}

/**
 * Lists boxes (optionally one project's), WITHOUT private keys.
 * @param {{ projectCwd?: string }} [opts]
 * @returns {Promise<BoxRecord[]>}
 */
async function listBoxes(opts) {
  const cwd = opts && opts.projectCwd;
  const boxes = await readBoxes(storeFile());
  return boxes.filter((b) => !cwd || b.projectCwd === cwd).map(publicRecord);
}

/**
 * @param {string} boxId
 * @returns {Promise<PrivateKeyJwk|null>}
 */
async function getPrivateKey(boxId) {
  if (!nonEmptyString(boxId)) return null;
  const hit = (await readBoxes(storeFile())).find((b) => b.boxId === boxId);
  return hit ? hit.privateKeyJwk : null;
}

/**
 * @param {string} boxId
 * @returns {Promise<boolean>} true when a box was removed
 */
function removeBox(boxId) {
  return mutateStore((boxes) => {
    const next = boxes.filter((b) => b.boxId !== boxId);
    return { boxes: next, result: next.length !== boxes.length };
  });
}

module.exports = { storeFile, addBox, listBoxes, getPrivateKey, removeBox };
