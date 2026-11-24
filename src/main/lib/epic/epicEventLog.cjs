'use strict';

/**
 * epicEventLog.cjs — the per-Epic durable event log (the Managed Agents
 * session event stream). THE ONLY WRITER of a project's
 * `session-manager-operations/events/` namespace (writer id 'event-log' in
 * lib/opsOwnership.cjs).
 *
 * Layout: events/<epicId>/events.jsonl — one JSON line per event:
 *   { seq, time, epicId, kind, ...summary fields }
 * `seq` is a per-Epic monotonic integer (1, 2, 3, ...) and the replay cursor;
 * `time` is an ISO-8601 UTC timestamp. Both are assigned here and cannot be
 * supplied by the caller.
 *
 * Kinds are a CLOSED {domain}.{action} set (EVENT_KINDS); an unknown kind
 * throws. Events carry summaries, never full transcript content: every string
 * field, at any depth, is capped at MAX_FIELD_CHARS.
 *
 * Concurrency: appends to one file are serialized by an in-process promise
 * chain keyed by file path; the last seq is cached per file and recovered from
 * the file on first use. Reads skip an unparsable (torn) line; an append
 * after a torn tail starts on a fresh line.
 *
 * Retention: keep forever (runtime, self-ignored).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');

const WRITER = 'event-log';
const NS = 'events';
const FILE_NAME = 'events.jsonl';
const MAX_FIELD_CHARS = 2000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const EPIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED = new Set(['seq', 'time', 'epicId', 'kind']);

const EVENT_KINDS = Object.freeze([
  'epic.minted',
  'epic.status_changed',
  'job.queued',
  'job.status_changed',
  'job.tool_use',
  'job.needs_input',
  'job.confirmation_requested',
  'human.message',
  'human.answer',
  'human.interrupt',
  'human.tool_confirmation',
  'external.message',
  'validator.verdict',
  'outcome.recorded',
  'artifact.published',
  'epic.state_changed',
]);
const KIND_SET = new Set(EVENT_KINDS);

/** file path → tail of its append chain. */
const chains = new Map();
/** file path → last seq written. */
const lastSeq = new Map();
/** Called with (cwd, record) after every successful append. */
const listeners = new Set();

/**
 * onEpicEventAppended(fn) → unsubscribe. fn(cwd, record) runs after each
 * record is on disk; a throwing listener is logged and never fails the append.
 * @param {(cwd: string, record: Record<string, unknown>) => void} fn
 */
function onEpicEventAppended(fn) {
  if (typeof fn !== 'function') throw new Error('epicEventLog: listener must be a function');
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function assertEpicId(epicId) {
  if (typeof epicId !== 'string' || !EPIC_ID_RE.test(epicId)) {
    throw new Error(`epicEventLog: invalid epicId "${epicId}"`);
  }
}

function assertKind(kind) {
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    throw new Error(`epicEventLog: unknown event kind "${kind}"`);
  }
}

function logFile(cwd, epicId) {
  return opsPath(cwd, NS, epicId, FILE_NAME);
}

/** Deep copy with every string capped at MAX_FIELD_CHARS. Drops functions/undefined via JSON later. */
function capFields(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[depth-capped]';
  if (Array.isArray(value)) return value.map((v) => capFields(v, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) out[capFields(k, depth + 1)] = capFields(v, depth + 1);
  return out;
}

/** Parse JSONL text; unparsable lines (a torn tail) are skipped. */
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && Number.isInteger(obj.seq)) out.push(obj);
    } catch { /* torn or corrupt line */ }
  }
  return out;
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * appendEpicEvent(cwd, epicId, event) → Promise<the written record>.
 * Throws (rejects) on an unknown kind or bad epicId before touching disk.
 */
function appendEpicEvent(cwd, epicId, event) {
  try {
    assertEpicId(epicId);
    if (!event || typeof event !== 'object') throw new Error('epicEventLog: event must be an object');
    assertKind(event.kind);
  } catch (err) {
    return Promise.reject(err);
  }
  let file;
  try {
    file = logFile(cwd, epicId);
    assertOpsWrite(file, WRITER);
  } catch (err) {
    return Promise.reject(err);
  }
  /** @type {Record<string, unknown>} */
  const payload = {};
  for (const [k, v] of Object.entries(event)) if (!RESERVED.has(k)) payload[k] = v;
  const capped = capFields(payload);

  const prev = chains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let prefix = '';
    if (!lastSeq.has(file)) {
      const text = await readText(file);
      const rows = parseLines(text);
      lastSeq.set(file, rows.reduce((m, r) => Math.max(m, r.seq), 0));
      if (text && !text.endsWith('\n')) prefix = '\n';
    } else {
      // Cheap tail check: a torn tail written by a crashed process.
      const fh = await fsp.open(file, 'a+').catch(() => null);
      if (fh) {
        try {
          const { size } = await fh.stat();
          if (size > 0) {
            const buf = Buffer.alloc(1);
            await fh.read(buf, 0, 1, size - 1);
            if (buf[0] !== 0x0a) prefix = '\n';
          }
        } finally { await fh.close(); }
      }
    }
    const seq = /** @type {number} */ (lastSeq.get(file)) + 1;
    const record = { seq, time: new Date().toISOString(), epicId, kind: event.kind, ...capped };
    await fsp.appendFile(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
    lastSeq.set(file, seq);
    for (const fn of [...listeners]) {
      try {
        fn(cwd, record);
      } catch (err) {
        console.error('[epicEventLog] listener failed', err && err.message ? err.message : String(err));
      }
    }
    return record;
  });
  chains.set(file, next);
  const cleanup = () => { if (chains.get(file) === next) chains.delete(file); };
  next.then(cleanup, cleanup);
  return next;
}

/**
 * readEpicEvents(cwd, epicId, { after, limit, kinds }) →
 *   Promise<{ events, cursor, hasMore }>
 * `after` — return only events with seq > after (default 0).
 * `cursor` — seq of the last returned event (or `after` when none) — pass it
 * back as `after` to resume. `hasMore` — more matching events remain.
 */
async function readEpicEvents(cwd, epicId, opts = {}) {
  assertEpicId(epicId);
  const after = Number.isInteger(opts.after) && opts.after > 0 ? opts.after : 0;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, MAX_LIMIT) : DEFAULT_LIMIT;
  let kindFilter = null;
  if (Array.isArray(opts.kinds) && opts.kinds.length) {
    opts.kinds.forEach(assertKind);
    kindFilter = new Set(opts.kinds);
  }
  const rows = parseLines(await readText(logFile(cwd, epicId)))
    .filter((r) => r.seq > after && (!kindFilter || kindFilter.has(r.kind)))
    .sort((a, b) => a.seq - b.seq);
  const events = rows.slice(0, limit);
  return {
    events,
    cursor: events.length ? events[events.length - 1].seq : after,
    hasMore: rows.length > limit,
  };
}

function _resetForTests() {
  chains.clear();
  lastSeq.clear();
  listeners.clear();
}

module.exports = {
  EVENT_KINDS,
  MAX_FIELD_CHARS,
  WRITER,
  appendEpicEvent,
  readEpicEvents,
  onEpicEventAppended,
  _resetForTests,
};
