'use strict';

/**
 * pendingReplies.cjs — machine-wide ledger of cross-project replies that are
 * OWED but not yet sendable: an "it's live" reply must wait until Session
 * Manager runs a version above the one the fix landed after, and the Epic
 * that owes it is often closed by then, so without a ledger the reply is
 * never sent (six were lost on 11-22/23).
 *
 * File: schedulerHome()/pending-replies.json (the folder that holds
 * admin-api.json; honors SM_SCHEDULER_HOME) = { version: 1, entries }.
 * An entry is due once appVersionAbove < running appVersion (strictly, via
 * seedDevPlugin.cjs compareSemver — an equal version is not due).
 * An entry with `commits` (release.commits) is further gated by the
 * deliverer on tag v<running version> containing every commit.
 * A missing or unreadable file reads as empty. Writes go through
 * util/atomicFs.cjs.
 *
 * Single writer: crossProjectReply.cjs is the ONLY caller of addPendingReply
 * and markReplyDelivered; everything else reads.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { writeJsonAtomicSync, readJsonOrSync } = require('../util/atomicFs.cjs');
const { schedulerHome } = require('../scheduler/schedulerPaths.cjs');
const { isCommitHash, MAX_COMMITS } = require('./replyClaims.cjs');

const STORE_VERSION = 1;
const FILE_NAME = 'pending-replies.json';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
/** Failed delivery attempts (one per hourly pass) before an entry gives up for good. */
const MAX_DELIVERY_ATTEMPTS = 24;

/** seedDevPlugin.cjs pulls electron-side modules; load its comparator only when needed. */
function compareSemver(a, b) {
  return require('../../seedDevPlugin.cjs').compareSemver(a, b);
}

function ledgerPath() {
  return path.join(schedulerHome(), FILE_NAME);
}

/** @returns {any[]} entries; [] for a missing/corrupt/ill-shaped file. */
function readEntries() {
  const doc = readJsonOrSync(ledgerPath(), null);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) return [];
  return doc.entries.filter((e) => e && typeof e === 'object' && typeof e.id === 'string');
}

function writeEntries(entries) {
  writeJsonAtomicSync(ledgerPath(), { version: STORE_VERSION, entries });
}

function isSemver(v) {
  return typeof v === 'string' && SEMVER_RE.test(v);
}

function str(v) {
  return typeof v === 'string' ? v : null;
}

function normalizeThread(t) {
  const o = t && typeof t === 'object' ? t : {};
  return {
    cwd: str(o.cwd),
    epicId: str(o.epicId),
    claudeSessionId: str(o.claudeSessionId),
    legacy: o.legacy === true,
    mode: str(o.mode),
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** A JSON-safe copy of the scheduling Epic's source (externalRef, proposal, replyTo, ...); null if not a plain object. */
function normalizeYSource(v) {
  if (!isPlainObject(v)) return null;
  try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
}

/**
 * Lowercased, de-duplicated commit hashes (replyClaims.isCommitHash), at most
 * MAX_COMMITS; invalid entries are dropped (the route already validated). [] when none.
 */
function normalizeCommits(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const c of v) {
    if (out.length === MAX_COMMITS) break;
    if (!isCommitHash(c)) continue;
    const lc = c.toLowerCase();
    if (!out.includes(lc)) out.push(lc);
  }
  return out;
}

/** Pure: build a full ledger entry from caller input. Throws on a bad appVersionAbove. */
function buildEntry(input, now = new Date()) {
  const e = input && typeof input === 'object' ? input : {};
  if (!isSemver(e.appVersionAbove)) {
    throw new Error(`pendingReplies: appVersionAbove must be x.y.z, got ${JSON.stringify(e.appVersionAbove)}`);
  }
  // release.commits the reply claims: delivery waits until tag v<running> holds every one.
  const commits = normalizeCommits(e.commits);
  return {
    id: crypto.randomUUID(),
    createdAt: now.toISOString(),
    replierCwd: str(e.replierCwd),
    yId: str(e.yId),
    goalText: str(e.goalText),
    thread: normalizeThread(e.thread),
    targetCwd: str(e.targetCwd),
    outcome: str(e.outcome),
    message: str(e.message),
    referencePaths: Array.isArray(e.referencePaths) ? e.referencePaths.filter((p) => typeof p === 'string') : [],
    appVersionAbove: e.appVersionAbove,
    ...(commits.length ? { commits } : {}),
    // What delivery needs once the scheduling Epic has closed: its source
    // (externalRef / proposal / replyTo) and the cap count this reply took.
    ySource: normalizeYSource(e.ySource),
    sentAtScheduling: Number.isInteger(e.sentAtScheduling) && e.sentAtScheduling > 0 ? e.sentAtScheduling : null,
    // replyHash(outcome, message) — an identical scheduled retry matches it.
    hash: str(e.hash),
    attempts: 0,
    gaveUpAt: null,
    deliveredAt: null,
    deliveredVersion: null,
    lastError: null,
  };
}

/** Pure: undelivered, not-given-up entries whose appVersionAbove is strictly below appVersion. */
function selectDue(entries, appVersion) {
  if (!isSemver(String(appVersion ?? '').split('-')[0])) return [];
  return entries.filter((e) => !e.deliveredAt && !e.gaveUpAt && isSemver(e.appVersionAbove)
    && compareSemver(e.appVersionAbove, appVersion) < 0);
}

function addPendingReply(entry) {
  const built = buildEntry(entry);
  const entries = readEntries();
  entries.push(built);
  writeEntries(entries);
  return built;
}

function listDueReplies(appVersion) {
  return selectDue(readEntries(), appVersion);
}

/** Pure: true for an undelivered, not-given-up entry of the thread (replierCwd + yId). */
function isPendingForThread(e, replierCwd, yId) {
  return !e.deliveredAt && !e.gaveUpAt && e.replierCwd === replierCwd && e.yId === yId;
}

/** How many of the thread's reply slots are held — a given-up entry frees its slot. */
function countPendingForThread(replierCwd, yId) {
  return listPendingForThread(replierCwd, yId).length;
}

/** Undelivered, not-given-up entries one thread (replierCwd + yId) still holds. */
function listPendingForThread(replierCwd, yId) {
  return readEntries().filter((e) => isPendingForThread(e, replierCwd, yId));
}

/**
 * Record a delivery attempt. result.ok !== false = delivered (deliveredAt +
 * deliveredVersion stamped, lastError cleared); otherwise lastError is set and
 * attempts is incremented; the MAX_DELIVERY_ATTEMPTS-th failure stamps
 * gaveUpAt and the entry is never due again. Returns the updated entry, or null for an unknown id.
 */
function failedAttempt(prev, lastError) {
  const attempts = (Number.isInteger(prev.attempts) && prev.attempts > 0 ? prev.attempts : 0) + 1;
  return {
    ...prev,
    attempts,
    lastError,
    gaveUpAt: attempts >= MAX_DELIVERY_ATTEMPTS ? new Date().toISOString() : (prev.gaveUpAt || null),
  };
}

function markReplyDelivered(id, { version, result } = {}) {
  const entries = readEntries();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const ok = !(result && typeof result === 'object' && result.ok === false);
  const prev = entries[idx];
  const next = ok
    ? { ...prev, deliveredAt: new Date().toISOString(), deliveredVersion: str(version), lastError: null }
    : failedAttempt(prev, str(result.error) || str(result.reason) || 'delivery failed');
  entries[idx] = next;
  writeEntries(entries);
  return next;
}

module.exports = {
  addPendingReply,
  listDueReplies,
  countPendingForThread,
  listPendingForThread,
  markReplyDelivered,
  MAX_DELIVERY_ATTEMPTS,
  ledgerPath,
  buildEntry,
  selectDue,
  STORE_VERSION,
};
