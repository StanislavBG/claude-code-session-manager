/**
 * toolClearance.cjs — single-use clearances for tool-risk 'confirm' calls.
 *
 * Flow (see session-manager-operations/architecture/tool-risk.md):
 *  1. The guard (scripts/hooks/lib/guard-tool-risk-policy.cjs) denies a
 *     confirm-marked call in a job and records a PENDING confirmation here
 *     (one record per tool + args digest, listing every job that asked).
 *  2. The owner answers the Needs-you item. The scheduler takes the pending
 *     record and calls answerConfirmation: it emits human.tool_confirmation,
 *     and on approve grants one clearance bound to (job, tool, args digest,
 *     project) and resumes the SAME Claude session; on deny it parks the job
 *     with reason confirmation_denied.
 *  3. In the resumed run the guard calls consumeClearance for the exact call.
 *     A matching live clearance lets exactly ONE call through: consumption is
 *     an atomic rename, so a second use (or a racing hook) finds nothing. A
 *     call with different args has a different digest, so it never matches.
 *
 * State lives machine-level under schedulerHome() (not the operations root):
 *   tool-clearances/<key>.json             live grants
 *   tool-confirmations-pending/<key>.json  pending confirmation records
 * Plain Node (no Electron) so the guard hook can require it.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomicSync } = require('../util/atomicFs.cjs');

const CLEARANCES_DIR = 'tool-clearances';
const PENDING_DIR = 'tool-confirmations-pending';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 7 * DEFAULT_TTL_MS;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_REQUESTS_PER_RECORD = 50;
const DENIED_REASON = 'confirmation_denied';
const NO_SESSION_REASON = 'confirmation_no_session';
const EVENT_KIND = 'human.tool_confirmation';

function home() {
  return require('./schedulerPaths.cjs').schedulerHome();
}

function clearancesDir(dir) { return dir || path.join(home(), CLEARANCES_DIR); }
function pendingDir(dir) { return dir || path.join(home(), PENDING_DIR); }

function sha(parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** File key of a clearance: one per (job, tool, args digest). */
function clearanceKey(jobSlug, tool, argsDigest) {
  return sha(['clearance', jobSlug, tool, argsDigest]).slice(0, 48);
}

/** File key of a pending confirmation: one per (tool, args digest), like its Needs-you item. */
function confirmationKey(tool, argsDigest) {
  return sha(['confirm', tool, argsDigest]).slice(0, 48);
}

function requireString(name, v) {
  if (typeof v !== 'string' || !v) throw new Error(`toolClearance: ${name} must be a non-empty string`);
}

function requireDigest(v) {
  if (typeof v !== 'string' || !DIGEST_RE.test(v)) throw new Error('toolClearance: argsDigest must be a sha256 hex digest');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Grant one single-use clearance. A new grant for the same key replaces the old one.
 * @param {{ cwd?: string|null, jobSlug: string, tool: string, argsDigest: string, ttlMs?: number, now?: number, dir?: string }} args
 * @returns {{ key: string, file: string, grantedAt: number, expiresAt: number }}
 */
function grantClearance({ cwd = null, jobSlug, tool, argsDigest, ttlMs = DEFAULT_TTL_MS, now = Date.now(), dir } = /** @type {any} */ ({})) {
  requireString('jobSlug', jobSlug);
  requireString('tool', tool);
  requireDigest(argsDigest);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, MAX_TTL_MS) : DEFAULT_TTL_MS;
  const key = clearanceKey(jobSlug, tool, argsDigest);
  const file = path.join(clearancesDir(dir), `${key}.json`);
  const record = { key, cwd: typeof cwd === 'string' && cwd ? cwd : null, jobSlug, tool, argsDigest, grantedAt: now, expiresAt: now + ttl };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomicSync(file, record);
  return { key, file, grantedAt: record.grantedAt, expiresAt: record.expiresAt };
}

/**
 * Consume the clearance for this exact call, at most once. Atomic: the grant
 * is renamed aside before it is read, so only one caller can ever win it.
 * A claimed grant is always deleted — expired or mismatched ones included.
 * @param {{ cwd?: string|null, jobSlug: string, tool: string, argsDigest: string, now?: number, dir?: string }} args
 * @returns {{ ok: true, clearance: object } | { ok: false, reason: 'none'|'expired'|'mismatch' }}
 */
function consumeClearance({ cwd = null, jobSlug, tool, argsDigest, now = Date.now(), dir } = /** @type {any} */ ({})) {
  if (typeof jobSlug !== 'string' || !jobSlug || typeof tool !== 'string' || !tool
    || typeof argsDigest !== 'string' || !DIGEST_RE.test(argsDigest)) {
    return { ok: false, reason: 'none' };
  }
  const file = path.join(clearancesDir(dir), `${clearanceKey(jobSlug, tool, argsDigest)}.json`);
  const claimed = `${file}.consumed-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(file, claimed);
  } catch {
    return { ok: false, reason: 'none' };
  }
  const record = readJson(claimed);
  try { fs.rmSync(claimed, { force: true }); } catch { /* best effort */ }
  if (!record || record.jobSlug !== jobSlug || record.tool !== tool || record.argsDigest !== argsDigest) {
    return { ok: false, reason: 'mismatch' };
  }
  if (!(typeof record.expiresAt === 'number' && record.expiresAt > now)) return { ok: false, reason: 'expired' };
  if (record.cwd && cwd && path.resolve(record.cwd) !== path.resolve(cwd)) return { ok: false, reason: 'mismatch' };
  return { ok: true, clearance: record };
}

/**
 * Delete every expired (or unreadable) grant. Never throws.
 * @param {{ now?: number, dir?: string }} [opts]
 * @returns {number} grants removed
 */
function pruneExpired({ now = Date.now(), dir } = {}) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(clearancesDir(dir)); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(clearancesDir(dir), name);
    const rec = readJson(file);
    if (rec && typeof rec.expiresAt === 'number' && rec.expiresAt > now) continue;
    try { fs.rmSync(file, { force: true }); removed++; } catch { /* next */ }
  }
  return removed;
}

// ── pending confirmations ───────────────────────────────────────────────────

/**
 * Record (or extend) the pending confirmation for one guard refusal. One
 * record per (tool, digest); each job asks at most once in it. Never throws.
 * @param {{ tool: string, argsDigest: string, jobSlug: string, sessionId?: string|null, epicId?: string|null, cwd?: string|null, rule?: string, summary?: string }} req
 * @param {{ dir?: string, now?: number }} [opts]
 * @returns {boolean}
 */
function recordPendingConfirmation(req, { dir, now = Date.now() } = {}) {
  try {
    requireString('tool', req.tool);
    requireDigest(req.argsDigest);
    requireString('jobSlug', req.jobSlug);
    const key = confirmationKey(req.tool, req.argsDigest);
    const file = path.join(pendingDir(dir), `${key}.json`);
    const existing = readJson(file);
    const requests = existing && Array.isArray(existing.requests) ? existing.requests : [];
    if (requests.some((r) => r && r.jobSlug === req.jobSlug)) return true;
    if (requests.length >= MAX_REQUESTS_PER_RECORD) return false;
    requests.push({
      tool: req.tool,
      argsDigest: req.argsDigest,
      jobSlug: req.jobSlug,
      sessionId: typeof req.sessionId === 'string' && req.sessionId ? req.sessionId : null,
      epicId: typeof req.epicId === 'string' && req.epicId ? req.epicId : null,
      cwd: typeof req.cwd === 'string' && req.cwd ? req.cwd : null,
      ...(typeof req.rule === 'string' ? { rule: req.rule } : {}),
      ...(typeof req.summary === 'string' ? { summary: req.summary } : {}),
      requestedAt: now,
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomicSync(file, { key, tool: req.tool, argsDigest: req.argsDigest, requests });
    return true;
  } catch (e) {
    console.error(`[toolClearance] pending confirmation not recorded: ${e && e.message}`);
    return false;
  }
}

/** @returns {{ key: string, tool: string, argsDigest: string, requests: object[] }[]} */
function listPendingConfirmations({ dir } = {}) {
  let names = [];
  try { names = fs.readdirSync(pendingDir(dir)); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const rec = readJson(path.join(pendingDir(dir), name));
    if (rec && typeof rec.key === 'string' && Array.isArray(rec.requests)) out.push(rec);
  }
  return out;
}

/** Atomically take (remove and return) one pending record, or null when it is gone. */
function takePendingConfirmation(key, { dir } = {}) {
  if (typeof key !== 'string' || !/^[0-9a-f]{1,64}$/.test(key)) return null;
  const file = path.join(pendingDir(dir), `${key}.json`);
  const claimed = `${file}.taken-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try { fs.renameSync(file, claimed); } catch { return null; }
  const rec = readJson(claimed);
  try { fs.rmSync(claimed, { force: true }); } catch { /* best effort */ }
  return rec && Array.isArray(rec.requests) ? rec : null;
}

// ── answering ───────────────────────────────────────────────────────────────

/**
 * Apply the owner's answer to one job's confirmation request.
 *  approve → emit human.tool_confirmation { approved: true }, grant the
 *            clearance, resume({ jobSlug, sessionId, request }) — same session.
 *  deny    → emit human.tool_confirmation { approved: false },
 *            park({ jobSlug, reason: 'confirmation_denied', request }).
 * An approval with no session id to resume parks with 'confirmation_no_session'.
 * @param {{ request: any, approved: boolean, ttlMs?: number, now?: number, dir?: string }} answer
 * @param {{ emit: (e: object) => void, resume: (r: object) => void, park: (p: object) => void }} deps
 * @returns {{ action: 'resume'|'park', clearance?: object }}
 */
function answerConfirmation({ request, approved, ttlMs, now = Date.now(), dir }, deps) {
  requireString('jobSlug', request && request.jobSlug);
  const event = {
    kind: EVENT_KIND,
    approved: approved === true,
    tool: request.tool,
    argsDigest: request.argsDigest,
    jobSlug: request.jobSlug,
    ...(request.rule ? { rule: request.rule } : {}),
  };
  try { deps.emit(event); } catch (e) { console.error(`[toolClearance] event emit failed: ${e && e.message}`); }
  if (approved === true && request.sessionId) {
    const clearance = grantClearance({
      cwd: request.cwd, jobSlug: request.jobSlug, tool: request.tool, argsDigest: request.argsDigest, ttlMs, now, dir,
    });
    deps.resume({ jobSlug: request.jobSlug, sessionId: request.sessionId, request });
    return { action: 'resume', clearance };
  }
  deps.park({ jobSlug: request.jobSlug, reason: approved === true ? NO_SESSION_REASON : DENIED_REASON, request });
  return { action: 'park' };
}

module.exports = {
  CLEARANCES_DIR,
  PENDING_DIR,
  DEFAULT_TTL_MS,
  DENIED_REASON,
  NO_SESSION_REASON,
  EVENT_KIND,
  clearanceKey,
  confirmationKey,
  grantClearance,
  consumeClearance,
  pruneExpired,
  recordPendingConfirmation,
  listPendingConfirmations,
  takePendingConfirmation,
  answerConfirmation,
};
