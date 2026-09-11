/**
 * telemetryClient — the single egress module that ships telemetry to
 * bilko.run's beacon endpoints (POST /api/telemetry/event, /log, /error).
 *
 * Records accumulate durably in ~/.config/session-manager/telemetry-queue.jsonl
 * the instant they're accepted, and are only ever sent by flush(reason) — on
 * a deliberate cadence (boot / daily / version-change / quit / manual), never
 * on a short interval. Every record is idempotent by recordId and stamped at
 * creation with the appVersion/platform/arch/machineDigest of the install
 * that produced it, so a record survives an upgrade with its original
 * attribution intact.
 *
 * Fail-inert like ../otel.cjs: every ingress function is wrapped so it can
 * never throw and never blocks the caller on real I/O completion (the
 * returned promise resolves once accepted/dropped, but callers are free to
 * not await it). Telemetry failing must stay invisible to the user.
 *
 * Single-writer precedent (../lib/instanceLock.cjs): this module assumes the
 * app's main process is the only writer of the queue/sent-set files for a
 * given machine. It does not itself arbitrate multiple OS processes.
 *
 * Wiring (who calls track/logLine/reportError, when flush('boot'/'quit') is
 * invoked) is deliberately out of scope here — this module only implements
 * the egress contract and its own internal daily cadence timer.
 */
'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config.cjs');
const telemetrySettings = require('./telemetrySettings.cjs');
const machineProfile = require('./machineProfile.cjs');

const MAX_BATCH = 50;
const QUEUE_CAP_COUNT = 5000;
const QUEUE_CAP_BYTES = 5 * 1024 * 1024;
const SENT_CAP = 5000;
const META_MAX_BYTES = 4000;
const MSG_MAX_CHARS = 500;
const STACK_MAX_CHARS = 16000;
const HOUR_MS = 60 * 60 * 1000;
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const ERR_DEDUP_WINDOW_MS = 60 * 1000;
const ERR_DEDUP_MAX_PER_WINDOW = 3;
const VALID_REASONS = new Set(['boot', 'daily', 'version-change', 'quit', 'manual']);
const ALLOWED_LEVELS = new Set(['info', 'warn', 'error']);

// Anti-noise tag only — ships inside a public npm package, never a secret.
const FALLBACK_BEACON_KEY = 'sm-beacon-a1c93f0e';

// Same redaction policy as opsErrorLog.cjs's REDACT_KEY (kept independent —
// no shared require — so this module has no dependency on ops-folder code).
const REDACT_KEY = /^(transcript|interim|final|text|content|partial|userText|message|token|secret|password|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;
// Unix absolute-path segments, not preceded by ':' (so "https://host/path"
// URLs in stack traces aren't mistaken for filesystem paths) and not
// preceded by '~' (so a path already reduced to homedir-relative by the
// os.homedir() substitution above isn't re-reduced to just its basename).
const ABS_PATH_RE = /(?<![:\w~])\/(?:[\w.\-]+\/)*[\w.\-]+/g;

/** Module-singleton state. Reset by deleting this module from require.cache. */
const S = {
  initPromise: null,
  settings: null,
  profile: null,
  profileBuildCount: 0,
  profileBuilder: machineProfile.buildMachineProfile,
  fetchImpl: null,
  sessionId: null,
  queue: [],
  queueIds: new Set(),
  sentIds: new Set(),
  sentOrder: [],
  consecutiveFailures: 0,
  backoffUntil: 0,
  disabledForProcess: false,
  dedupedAppends: 0,
  evictedCount: 0,
  recent: [],
  errSeen: new Map(),
  dailyTimer: null,
  flushChain: Promise.resolve(),
  lastError: null,
  lastFlushAt: null,
  lastFlushReason: null,
};

function queuePath() {
  return path.join(os.homedir(), '.config', 'session-manager', 'telemetry-queue.jsonl');
}

function sentPath() {
  return path.join(os.homedir(), '.config', 'session-manager', 'telemetry-sent.json');
}

function getBeaconToken() {
  return process.env.SM_BEACON_KEY || FALLBACK_BEACON_KEY;
}

// ─── safe coercion helpers (never throw, regardless of input shape) ───────

function safeObj(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function safeStr(v, maxLen) {
  if (v == null) return '';
  if (typeof v === 'string') return v.length > maxLen ? v.slice(0, maxLen) : v;
  try {
    const s = String(v);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  } catch {
    return '';
  }
}

function clampStr(s, n) {
  return typeof s === 'string' ? s.slice(0, n) : safeStr(s, n);
}

function redactString(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s.split(os.homedir()).join('~');
  out = out.replace(ABS_PATH_RE, (m) => path.basename(m));
  return out;
}

function hashCwd(cwd) {
  return crypto.createHash('sha256').update(String(cwd)).digest('hex').slice(0, 12);
}

/**
 * Recursively redacts + bounds an arbitrary user-supplied object: REDACT_KEY
 * keys -> '[redacted]', a literal `cwd` key -> `projectHash` (sha256(cwd)
 * truncated to 12 hex chars, raw cwd dropped entirely), string leaves get
 * homedir/path redaction + a per-leaf clamp, circular refs are cut via a
 * WeakSet, and object size is bounded by a max depth + max key/array count
 * so a 2 MB string leaf or a deeply nested object can't blow up downstream
 * JSON.stringify. O(n) in the number of visited nodes, each bounded — no
 * unbounded recursion even on a circular or adversarial input.
 */
function redactDeep(obj, seen, depth) {
  seen = seen || new WeakSet();
  depth = depth || 0;
  if (obj == null) return obj;
  if (typeof obj === 'string') return clampStr(redactString(obj), META_MAX_BYTES);
  if (typeof obj !== 'object') return obj;
  if (depth > 6) return '[MaxDepth]';
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);
  if (Array.isArray(obj)) {
    return obj.slice(0, 50).map((v) => redactDeep(v, seen, depth + 1));
  }
  const out = {};
  let count = 0;
  let keys;
  try {
    keys = Object.keys(obj);
  } catch {
    return {};
  }
  for (const k of keys) {
    if (count++ >= 50) break;
    let v;
    try {
      v = obj[k];
    } catch {
      continue;
    }
    if (k === 'cwd' && typeof v === 'string' && v) {
      out.projectHash = hashCwd(v);
      continue;
    }
    if (REDACT_KEY.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = redactDeep(v, seen, depth + 1);
  }
  return out;
}

/**
 * Merges redacted user content with the frozen attribution fields + recordId.
 * Attribution is merged AFTER redaction/clamping so it is never touched by
 * either, and if the combined payload still exceeds the server's meta byte
 * budget, user content is dropped entirely rather than attribution — the
 * four attribution fields + recordId must always survive intact.
 */
function buildMeta(userObjRedacted, attribution, recordId) {
  let candidate = { ...userObjRedacted, recordId, ...attribution };
  let json;
  try {
    json = JSON.stringify(candidate);
  } catch {
    candidate = { recordId, ...attribution };
    json = JSON.stringify(candidate);
  }
  if (Buffer.byteLength(json, 'utf8') > META_MAX_BYTES) {
    candidate = { recordId, ...attribution, _truncated: true };
  }
  return candidate;
}

function takeRecordId(obj) {
  if (obj && typeof obj.recordId === 'string' && obj.recordId) {
    const rest = { ...obj };
    delete rest.recordId;
    return { recordId: obj.recordId, rest };
  }
  return { recordId: crypto.randomUUID(), rest: obj };
}

function errorSignature(name, stack) {
  const firstFrame = (stack || '').split('\n').find((l) => l.includes('at ')) || '';
  return `${name}|${firstFrame.slice(0, 160)}`;
}

function errorDedupAllows(sig) {
  const now = Date.now();
  const entry = S.errSeen.get(sig);
  if (entry && (now - entry.windowStart) < ERR_DEDUP_WINDOW_MS) {
    if (entry.count >= ERR_DEDUP_MAX_PER_WINDOW) return false;
    entry.count += 1;
    return true;
  }
  S.errSeen.set(sig, { count: 1, windowStart: now });
  return true;
}

// ─── init ───────────────────────────────────────────────────────────────

function ensureInit() {
  if (S.initPromise) return S.initPromise;
  S.initPromise = (async () => {
    S.settings = await telemetrySettings.load();
    S.profile = await S.profileBuilder();
    S.profileBuildCount += 1;
    S.sessionId = crypto.randomUUID();
    await loadQueueFromDisk();
    await loadSentFromDisk();
    armDailyTimer();
  })();
  return S.initPromise;
}

async function loadQueueFromDisk() {
  try {
    const raw = await fsp.readFile(queuePath(), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.recordId === 'string' && !S.queueIds.has(rec.recordId)) {
          S.queue.push(rec);
          S.queueIds.add(rec.recordId);
        }
      } catch { /* skip malformed line */ }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') { /* best-effort read; queue starts empty */ }
  }
}

async function loadSentFromDisk() {
  try {
    const raw = await fsp.readFile(sentPath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.ids)) {
      for (const id of data.ids) {
        if (typeof id === 'string' && !S.sentIds.has(id)) {
          S.sentIds.add(id);
          S.sentOrder.push(id);
        }
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') { /* best-effort read; sent set starts empty */ }
  }
}

function armDailyTimer() {
  if (S.dailyTimer) return;
  S.dailyTimer = setInterval(() => {
    tickDaily().catch(() => {});
  }, HOUR_MS);
  if (S.dailyTimer.unref) S.dailyTimer.unref();
}

async function tickDaily() {
  await ensureInit();
  if (telemetrySettings.isDailyFlushDue(S.settings, Date.now())) {
    await flush('daily');
  }
}

// ─── queue persistence ─────────────────────────────────────────────────

async function persistAppendLine(rec) {
  const p = queuePath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.appendFile(p, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

/** Full atomic rewrite — only used after mark-done and cap eviction. */
async function persistQueueFull() {
  const body = S.queue.map((r) => JSON.stringify(r)).join('\n');
  const text = S.queue.length ? body + '\n' : '';
  await config.writeTextAtomic(queuePath(), text, { mode: 0o600 });
}

async function persistSent() {
  await config.writeJson(sentPath(), { ids: S.sentOrder, updatedAt: new Date().toISOString() }, { mode: 0o600 });
}

function recordBytes(r) {
  try {
    return Buffer.byteLength(JSON.stringify(r), 'utf8');
  } catch {
    return 0;
  }
}

/** Oldest-first eviction, bounded by count and total bytes. O(n) per call, n <= QUEUE_CAP_COUNT. */
async function enforceCap() {
  let changed = false;
  while (S.queue.length > QUEUE_CAP_COUNT) {
    const ev = S.queue.shift();
    S.queueIds.delete(ev.recordId);
    S.evictedCount += 1;
    changed = true;
  }
  let total = S.queue.reduce((a, r) => a + recordBytes(r), 0);
  while (total > QUEUE_CAP_BYTES && S.queue.length > 0) {
    const ev = S.queue.shift();
    S.queueIds.delete(ev.recordId);
    S.evictedCount += 1;
    total -= recordBytes(ev);
    changed = true;
  }
  if (changed) await persistQueueFull();
}

function addToSent(id) {
  if (S.sentIds.has(id)) return;
  S.sentIds.add(id);
  S.sentOrder.push(id);
  while (S.sentOrder.length > SENT_CAP) {
    const ev = S.sentOrder.shift();
    S.sentIds.delete(ev);
  }
}

function removeFromQueue(id) {
  const idx = S.queue.findIndex((r) => r.recordId === id);
  if (idx >= 0) {
    S.queue.splice(idx, 1);
    S.queueIds.delete(id);
  }
}

function pushRecent(rec) {
  S.recent.push({ recordId: rec.recordId, channel: rec.channel, wire: rec.wire });
  if (S.recent.length > 20) S.recent.shift();
}

async function appendRecord(channel, wire, recordId) {
  if (S.queueIds.has(recordId) || S.sentIds.has(recordId)) {
    S.dedupedAppends += 1;
    return { accepted: false, reason: 'duplicate', recordId };
  }
  const rec = { recordId, channel, wire };
  S.queue.push(rec);
  S.queueIds.add(recordId);
  try {
    await persistAppendLine(rec);
  } catch { /* best-effort; still tracked in-memory for this process */ }
  await enforceCap();
  pushRecent(rec);
  return { accepted: true, recordId };
}

// ─── ingress ────────────────────────────────────────────────────────────

async function track(name, props) {
  try {
    await ensureInit();
    if (!telemetrySettings.isEnabled(S.settings)) return { accepted: false, reason: 'disabled' };
    const { recordId, rest } = takeRecordId(safeObj(props));
    const redacted = redactDeep(rest);
    const meta = buildMeta(redacted, {
      appVersion: S.profile.appVersion,
      platform: S.profile.platform,
      arch: S.profile.arch,
      machineDigest: S.profile.machineDigest,
    }, recordId);
    const wire = {
      app: 'session-manager',
      name: safeStr(name, 200),
      props: meta,
      session_id: S.sessionId,
      visitor_id: S.settings.installId,
    };
    return await appendRecord('event', wire, recordId);
  } catch {
    return { accepted: false, reason: 'error' };
  }
}

async function logLine(opts) {
  try {
    await ensureInit();
    if (!telemetrySettings.isEnabled(S.settings)) return { accepted: false, reason: 'disabled' };
    const { recordId, rest } = takeRecordId(safeObj(opts));
    const level = ALLOWED_LEVELS.has(rest.level) ? rest.level : 'info';
    const msg = clampStr(redactString(safeStr(rest.msg, 20000)), MSG_MAX_CHARS);
    const fieldsRedacted = redactDeep(safeObj(rest.fields));
    const meta = buildMeta(fieldsRedacted, {
      platform: S.profile.platform,
      arch: S.profile.arch,
      machineDigest: S.profile.machineDigest,
    }, recordId);
    const wire = {
      app: 'session-manager',
      version: S.profile.appVersion,
      level,
      msg,
      visitor_id: S.settings.installId,
      session_id: S.sessionId,
      fields: meta,
      ts: Date.now(),
    };
    return await appendRecord('log', wire, recordId);
  } catch {
    return { accepted: false, reason: 'error' };
  }
}

async function reportError(opts) {
  try {
    await ensureInit();
    if (!telemetrySettings.isEnabled(S.settings)) return { accepted: false, reason: 'disabled' };
    const { recordId, rest } = takeRecordId(safeObj(opts));
    const name = safeStr(rest.name, 200) || 'Error';
    const rawStack = safeStr(rest.stack, 32000);
    const sig = errorSignature(name, rawStack);
    if (!errorDedupAllows(sig)) return { accepted: false, reason: 'error-dedup' };
    const msg = clampStr(redactString(safeStr(rest.msg, 20000)), MSG_MAX_CHARS);
    const stack = clampStr(redactString(rawStack), STACK_MAX_CHARS);
    const contextRedacted = redactDeep(safeObj(rest.context));
    const meta = buildMeta(contextRedacted, {
      platform: S.profile.platform,
      arch: S.profile.arch,
      machineDigest: S.profile.machineDigest,
    }, recordId);
    const wire = {
      app: 'session-manager',
      version: S.profile.appVersion,
      name,
      msg,
      stack,
      url: '',
      ua: '',
      visitor_id: S.settings.installId,
      session_id: S.sessionId,
      context: meta,
      ts: Date.now(),
    };
    return await appendRecord('error', wire, recordId);
  } catch {
    return { accepted: false, reason: 'error' };
  }
}

// ─── egress ────────────────────────────────────────────────────────────

async function sendBatch(channel, wireBatch) {
  const fetchFn = S.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchFn !== 'function') return { ok: false, status: 0 };
  const base = telemetrySettings.resolveEndpoint(S.settings);
  const url = `${base}/api/telemetry/${channel}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-SM-Beacon': `session-manager/${S.profile.appVersion}`,
    'X-SM-Beacon-Key': getBeaconToken(),
  };
  try {
    const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify({ batch: wireBatch }) });
    if (res && res.ok) return { ok: true };
    return { ok: false, status: res ? res.status : 0 };
  } catch {
    return { ok: false, status: 0 };
  }
}

function describeFailureStatus(status) {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}

function applyFailureBackoff(status) {
  if (status === 429 || status === 0 || status >= 500) {
    S.consecutiveFailures += 1;
    const ms = Math.min(BACKOFF_BASE_MS * (2 ** (S.consecutiveFailures - 1)), BACKOFF_MAX_MS);
    S.backoffUntil = Date.now() + ms;
    S.lastError = { status, message: describeFailureStatus(status), at: Date.now() };
    return;
  }
  if (status >= 400 && status < 500) {
    // Malformed-contract circuit breaker (includes 401) — not retried.
    S.disabledForProcess = true;
    S.lastError = { status, message: describeFailureStatus(status), at: Date.now() };
  }
}

/**
 * Serializes flush() calls through a chain (rather than a boolean lock) so
 * an automatic daily tick and an explicit caller-initiated flush (or two
 * overlapping ticks) can never interleave their queue-file rewrites —
 * each waits for the previous flush to fully settle before starting.
 */
function flush(reason) {
  const run = () => flushImpl(reason);
  const next = S.flushChain.then(run, run);
  S.flushChain = next.catch(() => {});
  return next;
}

async function flushImpl(reason) {
  const safeReason = VALID_REASONS.has(reason) ? reason : 'manual';
  const result = { sent: [], failed: [], reason: safeReason };
  try {
    await ensureInit();
    if (!telemetrySettings.isEnabled(S.settings)) return result;
    if (S.disabledForProcess) return result;
    if (Date.now() < S.backoffUntil) return result;

    const byChannel = { event: [], log: [], error: [] };
    for (const r of S.queue) {
      if (byChannel[r.channel]) byChannel[r.channel].push(r);
    }

    let sawFailure = false;
    for (const channel of ['event', 'log', 'error']) {
      if (sawFailure) break;
      const records = byChannel[channel];
      for (let i = 0; i < records.length; i += MAX_BATCH) {
        const batch = records.slice(i, i + MAX_BATCH);
        const res = await sendBatch(channel, batch.map((r) => r.wire));
        if (res.ok) {
          S.consecutiveFailures = 0;
          S.backoffUntil = 0;
          S.lastError = null;
          for (const r of batch) {
            removeFromQueue(r.recordId);
            addToSent(r.recordId);
            result.sent.push(r.recordId);
          }
        } else {
          for (const r of batch) result.failed.push(r.recordId);
          applyFailureBackoff(res.status);
          sawFailure = true;
          break;
        }
      }
    }

    await persistQueueFull();
    await persistSent();

    if (safeReason === 'daily' && result.failed.length === 0) {
      S.settings = await telemetrySettings.save({ ...S.settings, lastDailyFlushAt: new Date().toISOString() });
    }
  } catch { /* fail-inert */ }
  S.lastFlushAt = Date.now();
  S.lastFlushReason = safeReason;
  return result;
}

function shutdown() {
  if (S.dailyTimer) {
    clearInterval(S.dailyTimer);
    S.dailyTimer = null;
  }
}

function status() {
  return {
    pendingCount: S.queue.length,
    sentCount: S.sentIds.size,
    dedupedAppends: S.dedupedAppends,
    evictedCount: S.evictedCount,
    disabledForProcess: S.disabledForProcess,
    consecutiveFailures: S.consecutiveFailures,
    backoffUntil: S.backoffUntil,
    profileBuildCount: S.profileBuildCount,
    lastError: S.lastError,
    lastFlushAt: S.lastFlushAt,
    lastFlushReason: S.lastFlushReason,
  };
}

function recentRecords() {
  return S.recent.slice();
}

/**
 * Opt-out side effect: drops every not-yet-sent record from disk + memory so
 * a re-enable later never resends a payload that was only ever queued while
 * the user was opted out. Does NOT touch telemetry-sent.json or the backlog
 * watermarks — those describe history that already left the machine, and
 * clearing them would make a re-enable resend it. Never throws.
 */
async function clearQueue() {
  S.queue = [];
  S.queueIds = new Set();
  try {
    await config.writeTextAtomic(queuePath(), '', { mode: 0o600 });
  } catch { /* best-effort */ }
}

async function isPending(recordId) {
  await ensureInit();
  return S.queueIds.has(recordId);
}

// ─── test hooks ─────────────────────────────────────────────────────────

function _setFetchImpl(fn) {
  S.fetchImpl = typeof fn === 'function' ? fn : null;
}

function _setMachineProfileBuilder(fn) {
  S.profileBuilder = typeof fn === 'function' ? fn : machineProfile.buildMachineProfile;
}

module.exports = {
  track,
  logLine,
  reportError,
  flush,
  shutdown,
  status,
  recentRecords,
  isPending,
  clearQueue,
  queuePath,
  sentPath,
  _setFetchImpl,
  _setMachineProfileBuilder,
};
