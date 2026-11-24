// @ts-check
/**
 * siteFeedbackInbox — the ONLY writer of <project>/session-manager-operations/feedback-inbox/.
 * One folder per decrypted website-widget report:
 *
 *   feedback-inbox/items/<hostId>/report.json      the validated Report v1 (feedbackReport.cjs)
 *   feedback-inbox/items/<hostId>/meta.json        { hostId, boxId, receivedAt, origin, status,
 *                                                     statusNote, epicId, statusChangedAt,
 *                                                     reporterVerified }
 *   feedback-inbox/items/<hostId>/screenshot.png
 *   feedback-inbox/items/<hostId>/annotated.png
 *   feedback-inbox/index.json                      { version: 1, byClientReportId: { [clientReportId]: hostId } }
 *                                                     — the dedupe index; rebuilt from items/ when
 *                                                     missing or corrupt, so it is a cache, not truth
 *   feedback-inbox/rejected.jsonl                  one { at, boxId, hostId, code, bytes } line per
 *                                                     envelope the drain could not open (no content)
 *
 * The inbox UI, Open as Epic and the Feedback MCP all read through this module. Every write goes
 * through config.cjs writers as writer 'feedback-inbox' (single-writer law, opsOwnership.cjs);
 * deletes pass assertOpsWrite first. The namespace is runtime (personal data), so its self-ignore
 * `.gitignore` is ensured after every write. hostId must match ^FB-[0-9A-Z]{5}$ and every resolved
 * path is checked to stay inside the namespace. Writes are serialized in-process so dedupe on
 * report.clientReportId cannot race. Dedupe is one index lookup: the index entry is written BEFORE
 * the item files (meta.json last), so a crash mid-write leaves an entry whose item has no meta.json;
 * the next write of that clientReportId under the same hostId resumes it, and a lookup whose item
 * is gone drops the entry. A hostId already stored for a different clientReportId is refused with
 * an error whose `code` is 'host_id_clash' (the drain records and acks such an envelope).
 *
 * Every write path first registers cwd with config.addAllowedRoot, so a project root nothing
 * else registered this session is still writable — but only a known widget project (a box's
 * projectCwd, or a cwd already holding feedback-inbox/); any other cwd throws code
 * 'unknown_project' and the boundary is not widened (see registerRoot).
 *
 * `reporterVerified` is the drain's signed-reporter check (feedbackBoxDrain.cjs): true, false or
 * null (no signature); anything else given to writeItem is stored as null.
 *
 * `statusChangedAt` (receivedAt at write, then the time of each setStatus) is what prune() ages.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../config.cjs');
const feedbackBoxKeys = require('./feedbackBoxKeys.cjs');
const { readJsonOr } = require('../util/atomicFs.cjs');
const { opsPath, assertOpsWrite, ensureRuntimeIgnores, resolveProjectRoot } = require('../opsOwnership.cjs');

const NAMESPACE = 'feedback-inbox';
const WRITER = 'feedback-inbox';
const HOST_ID_RE = /^FB-[0-9A-Z]{5}$/;
const STATUSES = /** @type {const} */ (['open', 'in_progress', 'resolved', 'wontfix']);
const PRUNABLE = new Set(['resolved', 'wontfix']);
const MAX_STATUS_NOTE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {(typeof STATUSES)[number]} InboxStatus
 * @typedef {{ hostId: string, boxId: string, receivedAt: string, origin: string,
 *   status: InboxStatus, statusNote: string | null, epicId: string | null,
 *   statusChangedAt: string, reporterVerified?: boolean | null }} InboxMeta
 * @typedef {InboxMeta & { title: string, type: string, reporter: { id: string, name: string | null, email: string | null } | null }} InboxSummary
 */

/** @type {Promise<unknown>} */
let queue = Promise.resolve();
/**
 * Run fn after every earlier queued write; errors propagate to the caller only.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** @param {unknown} hostId */
function assertHostId(hostId) {
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) {
    throw new Error('siteFeedbackInbox: hostId must match ^FB-[0-9A-Z]{5}$');
  }
}

/** @param {string} cwd */
function nsRoot(cwd) {
  return opsPath(cwd, NAMESPACE);
}

/** @param {string} cwd */
function indexPath(cwd) {
  return path.join(nsRoot(cwd), 'index.json');
}

/** @param {string} cwd */
function itemsRoot(cwd) {
  return path.join(nsRoot(cwd), 'items');
}

/**
 * Absolute path of an item folder (or a file in it), refusing anything outside the namespace.
 * @param {string} cwd
 * @param {string} hostId
 * @param {string} [file]
 */
function itemPath(cwd, hostId, file) {
  assertHostId(hostId);
  const root = nsRoot(cwd);
  const p = file ? path.join(itemsRoot(cwd), hostId, file) : path.join(itemsRoot(cwd), hostId);
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('siteFeedbackInbox: path escapes the feedback-inbox namespace');
  }
  return p;
}

/** @param {string} abs @returns {Promise<any>} */
function readJsonFile(abs) {
  return readJsonOr(abs, null);
}

/** @param {string} cwd @returns {Promise<string[]>} */
async function listHostIds(cwd) {
  let names;
  try {
    names = await fsp.readdir(itemsRoot(cwd));
  } catch {
    return [];
  }
  return names.filter((n) => HOST_ID_RE.test(n));
}

/** @param {string} abs @param {unknown} data */
async function writeJson(abs, data) {
  await config.writeJson(abs, data, { writer: WRITER });
}

/** @param {string} cwd */
function ensureIgnore(cwd) {
  ensureRuntimeIgnores(resolveProjectRoot(cwd));
}

/**
 * Error for a cwd that is not a known widget project; `code` is 'unknown_project'.
 * @param {string} message
 */
function unknownProject(message) {
  const err = new Error(`siteFeedbackInbox: ${message}`);
  /** @type {any} */ (err).code = 'unknown_project';
  return err;
}

/** @param {string} p */
function isDirSync(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** @param {string} parent @param {string} child true when child is strictly inside parent */
function isStrictAncestor(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** @param {string} p @returns {string | null} canonical real path, or null when it does not resolve */
function realOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/**
 * One operation's keystore view: the box list is read at most once per scope and never cached
 * across calls (a fresh scope per writeItem/updateMeta/... call).
 * @typedef {{ boxes: () => Promise<Array<{ projectCwd?: unknown }>> }} RootScope
 * @returns {RootScope}
 */
function rootScope() {
  /** @type {Promise<Array<{ projectCwd?: unknown }>> | null} */
  let pending = null;
  return { boxes: () => (pending ||= feedbackBoxKeys.listBoxes()) };
}

/**
 * Widen config.cjs's write boundary to this project root right before a write, as
 * projectHomeAdminRoutes.cjs does: the drain reaches projects no pty/route registered this
 * session. Only a known widget project is registered: cwd must be absolute, an existing
 * directory, and either the projectCwd of a box in feedbackBoxKeys or already hold a
 * session-manager-operations/feedback-inbox/ namespace. Paths compare as fs.realpathSync
 * canonical paths, so a symlink to a known project is known; a box projectCwd that does not
 * resolve matches nothing. The home directory, the filesystem root and (for the namespace case)
 * any ancestor of a box's project are never registered. Anything else throws `unknown_project`
 * before the boundary is touched.
 * @param {unknown} cwd
 * @param {RootScope} [scope] reuse one keystore read across a single operation's re-registrations
 * @returns {Promise<string>} the canonical root registered
 */
async function registerRoot(cwd, scope = rootScope()) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
    throw new Error('siteFeedbackInbox: cwd must be an absolute path');
  }
  if (!isDirSync(cwd)) throw new Error('siteFeedbackInbox: cwd does not exist or is not a directory');
  const abs = realOrNull(cwd);
  if (!abs) throw unknownProject('cwd does not resolve to a real path');
  const home = realOrNull(os.homedir()) || path.resolve(os.homedir());
  if (abs === home || abs === path.resolve(os.homedir()) || abs === path.parse(abs).root) {
    throw unknownProject('the home directory or filesystem root is never a feedback project');
  }
  const boxes = await scope.boxes();
  /** @type {string[]} */
  const projects = [];
  for (const b of boxes) {
    const real = b && typeof b.projectCwd === 'string' ? realOrNull(b.projectCwd) : null;
    if (real) projects.push(real);
  }
  let known = projects.includes(abs);
  if (!known && !projects.some((p) => isStrictAncestor(abs, p))) {
    let ns = '';
    try { ns = nsRoot(abs); } catch { /* not a resolvable project root */ }
    known = !!ns && isDirSync(ns);
  }
  if (!known) throw unknownProject('cwd is not a project with a feedback widget');
  config.addAllowedRoot(abs);
  return abs;
}

/** @typedef {Record<string, string>} ClientIdIndex clientReportId -> hostId */

/** @param {unknown} raw @returns {ClientIdIndex | null} */
function parseIndex(raw) {
  const r = /** @type {any} */ (raw);
  if (!r || typeof r !== 'object' || r.version !== 1) return null;
  const by = r.byClientReportId;
  if (!by || typeof by !== 'object' || Array.isArray(by)) return null;
  /** @type {ClientIdIndex} */
  const out = Object.create(null);
  for (const [k, v] of Object.entries(by)) {
    if (typeof v !== 'string' || !HOST_ID_RE.test(v)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * The dedupe index, rebuilt from items/<hostId>/report.json when missing or corrupt.
 * Call only inside serialize().
 * @param {string} cwd
 * @returns {Promise<ClientIdIndex>}
 */
async function loadIndex(cwd) {
  const parsed = parseIndex(await readJsonFile(indexPath(cwd)));
  if (parsed) return parsed;
  /** @type {ClientIdIndex} */
  const rebuilt = Object.create(null);
  for (const id of await listHostIds(cwd)) {
    const report = await readJsonFile(itemPath(cwd, id, 'report.json'));
    const crid = report && typeof report === 'object' ? report.clientReportId : undefined;
    if (typeof crid === 'string' && crid && !(crid in rebuilt)) rebuilt[crid] = id;
  }
  return rebuilt;
}

/** @param {string} cwd @param {ClientIdIndex} index @param {RootScope} [scope] */
async function saveIndex(cwd, index, scope) {
  await registerRoot(cwd, scope);
  await writeJson(indexPath(cwd), { version: 1, byClientReportId: { ...index } });
}

/** @param {string} abs */
async function exists(abs) {
  try { await fsp.access(abs); return true; } catch { return false; }
}

/** @param {unknown} v @param {string} name */
function requireString(v, name) {
  if (typeof v !== 'string' || !v) throw new Error(`siteFeedbackInbox: ${name} must be a non-empty string`);
  return v;
}

/** @param {unknown} v @param {string} name */
function requireBuffer(v, name) {
  if (!Buffer.isBuffer(v) && !(v instanceof Uint8Array)) throw new Error(`siteFeedbackInbox: ${name} must be a Buffer`);
  return v;
}

/**
 * Store one decrypted report. No-op `{ duplicate: true }` when report.clientReportId is already stored.
 * @param {{ cwd: string, hostId: string, boxId: string, receivedAt: string, origin: string,
 *   report: { clientReportId: string } & Record<string, unknown>, screenshot: Uint8Array, annotated: Uint8Array,
 *   reporterVerified?: boolean | null }} args
 * @returns {Promise<{ duplicate: true, hostId: string } | { duplicate: false, hostId: string }>}
 */
async function writeItem(args) {
  const { cwd, hostId, boxId, receivedAt, origin, report, screenshot, annotated, reporterVerified } = args || /** @type {any} */ ({});
  assertHostId(hostId);
  requireString(boxId, 'boxId');
  requireString(receivedAt, 'receivedAt');
  requireString(origin, 'origin');
  if (!report || typeof report !== 'object') throw new Error('siteFeedbackInbox: report must be an object');
  const clientReportId = requireString(report.clientReportId, 'report.clientReportId');
  requireBuffer(screenshot, 'screenshot');
  requireBuffer(annotated, 'annotated');
  const scope = rootScope();
  await registerRoot(cwd, scope);
  return serialize(async () => {
    const index = await loadIndex(cwd);
    const known = index[clientReportId];
    let resume = false;
    if (known) {
      if (await exists(itemPath(cwd, known, 'meta.json'))) return { duplicate: true, hostId: known };
      // Entry without a complete item: a crashed write (resume it if same hostId) or a stale entry.
      if (known === hostId) resume = true;
      else delete index[clientReportId];
    }
    if (!resume && await exists(itemPath(cwd, hostId))) {
      const err = new Error(`siteFeedbackInbox: hostId ${hostId} is already stored for another report`);
      /** @type {any} */ (err).code = 'host_id_clash';
      throw err;
    }
    index[clientReportId] = hostId;
    await saveIndex(cwd, index, scope);
    await registerRoot(cwd, scope);
    await config.writeBinaryAtomic(itemPath(cwd, hostId, 'screenshot.png'), screenshot, { writer: WRITER });
    await config.writeBinaryAtomic(itemPath(cwd, hostId, 'annotated.png'), annotated, { writer: WRITER });
    await writeJson(itemPath(cwd, hostId, 'report.json'), report);
    /** @type {InboxMeta} */
    const meta = {
      hostId, boxId, receivedAt, origin,
      status: 'open', statusNote: null, epicId: null,
      statusChangedAt: receivedAt,
      reporterVerified: typeof reporterVerified === 'boolean' ? reporterVerified : null,
    };
    // meta.json last: an item with meta.json is complete.
    await writeJson(itemPath(cwd, hostId, 'meta.json'), meta);
    ensureIgnore(cwd);
    return { duplicate: false, hostId };
  });
}

const REJECT_CODE_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Append one line to feedback-inbox/rejected.jsonl for an envelope the drain could not open.
 * Only the fixed fields are written — never report text, image bytes or key material.
 * @param {{ cwd: string, at: string, boxId: string, hostId: string, code: string, bytes: number }} args
 * @returns {Promise<void>}
 */
async function appendRejected(args) {
  const { cwd, at, boxId, hostId, code, bytes } = args || /** @type {any} */ ({});
  requireString(at, 'at');
  requireString(boxId, 'boxId');
  if (typeof hostId !== 'string') throw new Error('siteFeedbackInbox: hostId must be a string');
  if (typeof code !== 'string' || !REJECT_CODE_RE.test(code)) throw new Error('siteFeedbackInbox: code must be a short snake_case code');
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('siteFeedbackInbox: bytes must be a non-negative number');
  const scope = rootScope();
  await registerRoot(cwd, scope);
  const line = JSON.stringify({ at, boxId, hostId: hostId.slice(0, 64), code, bytes }) + '\n';
  const file = path.join(nsRoot(cwd), 'rejected.jsonl');
  return serialize(async () => {
    /** @type {string} */
    let prev = '';
    try { prev = await fsp.readFile(file, 'utf8'); } catch { /* first line */ }
    if (prev && !prev.endsWith('\n')) prev += '\n';
    await registerRoot(cwd, scope);
    await config.writeTextAtomic(file, prev + line, { writer: WRITER });
    ensureIgnore(cwd);
  });
}

/** @param {unknown} report */
function summarize(report) {
  const r = /** @type {any} */ (report) || {};
  const u = r.user && typeof r.user === 'object' ? r.user : null;
  return {
    title: typeof r.title === 'string' ? r.title : '',
    type: typeof r.type === 'string' ? r.type : 'other',
    reporter: u ? {
      id: typeof u.id === 'string' ? u.id : '',
      name: typeof u.name === 'string' ? u.name : null,
      email: typeof u.email === 'string' ? u.email : null,
    } : null,
  };
}

/** @param {string} cwd @param {string} hostId @returns {Promise<InboxMeta | null>} */
async function readMeta(cwd, hostId) {
  const meta = await readJsonFile(itemPath(cwd, hostId, 'meta.json'));
  return meta && typeof meta === 'object' && meta.hostId === hostId ? meta : null;
}

/**
 * All stored items (meta + title/type/reporter), newest receivedAt first.
 * @param {string} cwd
 * @param {{ status?: InboxStatus }} [opts]
 * @returns {Promise<InboxSummary[]>}
 */
async function list(cwd, opts = {}) {
  const want = opts && opts.status;
  if (want !== undefined && !STATUSES.includes(want)) throw new Error('siteFeedbackInbox: unknown status filter');
  /** @type {InboxSummary[]} */
  const out = [];
  for (const id of await listHostIds(cwd)) {
    const meta = await readMeta(cwd, id);
    if (!meta) continue;
    if (want && meta.status !== want) continue;
    const report = await readJsonFile(itemPath(cwd, id, 'report.json'));
    out.push({ ...meta, ...summarize(report) });
  }
  out.sort((a, b) => (Date.parse(b.receivedAt) || 0) - (Date.parse(a.receivedAt) || 0)
    || b.hostId.localeCompare(a.hostId));
  return out;
}

/**
 * One item, or null when absent.
 * @param {string} cwd
 * @param {string} hostId
 */
async function get(cwd, hostId) {
  const meta = await readMeta(cwd, hostId);
  if (!meta) return null;
  const report = await readJsonFile(itemPath(cwd, hostId, 'report.json'));
  /** @type {{ screenshot: string | null, annotated: string | null }} */
  const imagePaths = { screenshot: null, annotated: null };
  for (const k of /** @type {const} */ (['screenshot', 'annotated'])) {
    const p = itemPath(cwd, hostId, `${k}.png`);
    try { await fsp.access(p); imagePaths[k] = p; } catch { /* absent */ }
  }
  return { meta, report, imagePaths };
}

/**
 * Read-modify-write meta.json under the write queue.
 * @param {string} cwd
 * @param {string} hostId
 * @param {(meta: InboxMeta) => InboxMeta} patch
 */
async function updateMeta(cwd, hostId, patch) {
  assertHostId(hostId);
  const scope = rootScope();
  await registerRoot(cwd, scope);
  return serialize(async () => {
    const meta = await readMeta(cwd, hostId);
    if (!meta) throw new Error(`siteFeedbackInbox: no item ${hostId}`);
    const next = patch(meta);
    await registerRoot(cwd, scope);
    await writeJson(itemPath(cwd, hostId, 'meta.json'), next);
    ensureIgnore(cwd);
    return next;
  });
}

/**
 * Set the owner's status (+ optional note, at most 500 chars).
 * @param {string} cwd
 * @param {string} hostId
 * @param {InboxStatus} status
 * @param {string | null} [note]
 * @param {{ now?: number }} [opts]
 */
async function setStatus(cwd, hostId, status, note = null, opts = {}) {
  if (!STATUSES.includes(status)) throw new Error('siteFeedbackInbox: status must be open, in_progress, resolved or wontfix');
  if (note != null && (typeof note !== 'string' || note.length > MAX_STATUS_NOTE)) {
    throw new Error(`siteFeedbackInbox: note must be a string of at most ${MAX_STATUS_NOTE} chars`);
  }
  const at = new Date(opts.now ?? Date.now()).toISOString();
  return updateMeta(cwd, hostId, (m) => ({ ...m, status, statusNote: note || null, statusChangedAt: at }));
}

/**
 * Record the Epic opened from this item.
 * @param {string} cwd
 * @param {string} hostId
 * @param {string} epicId
 */
async function linkEpic(cwd, hostId, epicId) {
  if (typeof epicId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(epicId)) {
    throw new Error('siteFeedbackInbox: epicId must be a safe Epic id');
  }
  return updateMeta(cwd, hostId, (m) => ({ ...m, epicId }));
}

/** @param {string} cwd @param {string} hostId @param {RootScope} [scope] */
async function removeNow(cwd, hostId, scope) {
  const dir = itemPath(cwd, hostId);
  await registerRoot(cwd, scope);
  assertOpsWrite(dir, WRITER);
  await fsp.rm(dir, { recursive: true, force: true });
}

/**
 * Remove index entries pointing at removed hostIds. Call only inside serialize().
 * @param {string} cwd
 * @param {Set<string>} hostIds
 * @param {RootScope} [scope]
 */
async function dropFromIndex(cwd, hostIds, scope) {
  const index = await loadIndex(cwd);
  let changed = false;
  for (const [crid, id] of Object.entries(index)) {
    if (hostIds.has(id)) { delete index[crid]; changed = true; }
  }
  if (changed) await saveIndex(cwd, index, scope);
}

/**
 * Delete one item. Returns whether it existed.
 * @param {string} cwd
 * @param {string} hostId
 */
async function remove(cwd, hostId) {
  assertHostId(hostId);
  const scope = rootScope();
  await registerRoot(cwd, scope);
  return serialize(async () => {
    let existed = true;
    try { await fsp.access(itemPath(cwd, hostId)); } catch { existed = false; }
    await removeNow(cwd, hostId, scope);
    await dropFromIndex(cwd, new Set([hostId]), scope);
    return { removed: existed };
  });
}

/**
 * Delete resolved/wontfix items whose status changed more than `days` ago.
 * @param {string} cwd
 * @param {number} days
 * @param {{ now?: number }} [opts]
 * @returns {Promise<string[]>} pruned hostIds
 */
async function prune(cwd, days, opts = {}) {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
    throw new Error('siteFeedbackInbox: days must be a non-negative number');
  }
  const scope = rootScope();
  await registerRoot(cwd, scope);
  const cutoff = (opts.now ?? Date.now()) - days * DAY_MS;
  return serialize(async () => {
    /** @type {string[]} */
    const pruned = [];
    for (const id of await listHostIds(cwd)) {
      const meta = await readMeta(cwd, id);
      if (!meta || !PRUNABLE.has(meta.status)) continue;
      const changed = Date.parse(meta.statusChangedAt || meta.receivedAt);
      if (!Number.isFinite(changed) || changed >= cutoff) continue;
      await removeNow(cwd, id, scope);
      pruned.push(id);
    }
    if (pruned.length) await dropFromIndex(cwd, new Set(pruned), scope);
    return pruned;
  });
}

module.exports = {
  writeItem,
  appendRejected,
  list,
  get,
  setStatus,
  linkEpic,
  remove,
  prune,
  STATUSES,
  HOST_ID_RE,
  MAX_STATUS_NOTE,
  HOST_ID_CLASH: 'host_id_clash',
};
