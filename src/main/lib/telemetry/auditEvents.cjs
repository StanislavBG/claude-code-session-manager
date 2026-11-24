/**
 * auditEvents.cjs — cursor reader over the audit log for outside apps.
 *
 * readEventsAfter({ after, kinds, limit, target }) → { events, next, more, gap }.
 *
 * Cursor = `<at of the last row handed out>~<count of rows with exactly that at
 * already handed out>`. "Handed out" means scanned: next advances past every row
 * this call looked at, matching or not, so rows sharing one timestamp are never
 * skipped or repeated. `after` absent → no events, next = newest live row (start
 * from now). `after === 'start'` → from the first row of the live file.
 *
 * The live file is read with readTail in a growing window (1 MB, doubling) until
 * the window's first row is strictly before the cursor's at (so the whole group of
 * rows sharing the cursor's at is visible) or the whole file is covered. Only when
 * the cursor is at or before the live file's first row is the newest rotated
 * archive (`audit-log-YYYY-MM.jsonl.gz`, same folder) unzipped in memory and its
 * rows prepended — unless its compressed size exceeds MAX_ARCHIVE_GZ_BYTES (or the
 * maxArchiveGzBytes option), in which case it is skipped and gap is true.
 * gap = the cursor predates the oldest row still readable.
 *
 * Assumes rows are appended in non-decreasing `at` order (they are: appendAuditEvent
 * stamps `now` at append time). Rows that fail to parse or lack a string `at` are skipped.
 *
 * epic_state_changed is read from the per-Epic event logs, not from audit rows:
 * every `epic.state_changed` event (written by lib/epic/epicStateEmitter.cjs with
 * the fine-grained outside state, lib/epic/epicEventLog.cjs) of every registered
 * project becomes one row
 * { at, kind: 'epic_state_changed', cwd, epicId, from, to, blockedKind?, externalRef? }
 * (epicStateRowOf; blockedKind only on a `to: 'blocked'` row), merged into the
 * audit rows by `at` (ties: audit rows first, then cwd, epicId, seq) so one cursor
 * covers both. Lifecycle-only `epic.status_changed` events yield no row.
 * Legacy epic_state_changed audit rows already in the log stay readable.
 * Projects come from the `projectRoots` option, else — only when `target` is not
 * given — promptSessionsIpc's registered projects (cached EPIC_ROOTS_TTL_MS).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { auditLogPath, readTail } = require('./auditLog.cjs');
const { opsPath } = require('../opsOwnership.cjs');

const OUTSIDE_EVENT_KINDS = Object.freeze(['epic_state_changed', 'job_transition', 'epic_cross_project_reply', 'needs_you_answered']);
const DEFAULT_KINDS = Object.freeze(['epic_state_changed']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const INITIAL_WINDOW = 1024 * 1024;
/** Largest compressed archive loadArchive will unzip in memory; a bigger one is skipped (gap true). */
const MAX_ARCHIVE_GZ_BYTES = 16 * 1024 * 1024;
const START = 'start';
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)~(\d+)$/;
const CURSOR_FORM = "expected '<ISO timestamp>~<count>' (e.g. 2026-11-01T00:00:00.000Z~1) or 'start'";
/** `code` of the Error parseCursor throws for a malformed cursor. */
const INVALID_AUDIT_CURSOR = 'INVALID_AUDIT_CURSOR';

/** @param {unknown} after */
function parseCursor(after) {
  if (after === START) return { start: true, at: '', n: 0 };
  const m = typeof after === 'string' ? CURSOR_RE.exec(after) : null;
  if (!m) {
    const err = /** @type {Error & { code: string }} */ (new Error(`invalid audit cursor ${JSON.stringify(after)}: ${CURSOR_FORM}`));
    err.code = INVALID_AUDIT_CURSOR;
    throw err;
  }
  return { start: false, at: m[1], n: Number(m[2]) };
}

/** @param {string[]} lines */
function parseRows(lines) {
  const rows = [];
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.at === 'string') rows.push(r);
  }
  return rows;
}

function fileSize(target) {
  try { return fs.statSync(target).size; } catch { return 0; }
}

/**
 * Live rows, widening the tail window until its first row is strictly before
 * `boundaryAt` (or the whole file is read). `boundaryAt === null` → whole file.
 * @returns {{ rows: object[], whole: boolean }}
 */
function loadLive(target, boundaryAt, initialWindow) {
  let win = Math.max(1, initialWindow);
  for (;;) {
    const size = fileSize(target);
    const whole = boundaryAt === null || win >= size;
    const rows = parseRows(readTail(whole ? Math.max(size, 1) : win, target));
    if (whole) return { rows, whole: true };
    if (rows.length && rows[0].at < boundaryAt) return { rows, whole: false };
    win *= 2;
  }
}

/**
 * Newest rotated archive's rows (in memory). rows = [] when none / unreadable;
 * skipped = true when its compressed size is over `maxGzBytes` (never read).
 * @returns {{ rows: object[], skipped: boolean }}
 */
function loadArchive(target, maxGzBytes) {
  const dir = path.dirname(target);
  const base = path.basename(target, path.extname(target));
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}\\.jsonl\\.gz$`);
  let names;
  const none = { rows: [], skipped: false };
  try { names = fs.readdirSync(dir).filter((f) => re.test(f)).sort(); } catch { return none; }
  if (!names.length) return none;
  const file = path.join(dir, names[names.length - 1]);
  try {
    if (fs.statSync(file).size > maxGzBytes) return { rows: [], skipped: true };
    return { rows: parseRows(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean)), skipped: false };
  } catch { return none; }
}

/** Annotate each row with its 1-based occurrence among rows sharing its `at`. */
function withOrdinals(rows) {
  const out = [];
  let prevAt = null;
  let k = 0;
  for (const r of rows) {
    k = r.at === prevAt ? k + 1 : 1;
    prevAt = r.at;
    out.push({ row: r, ord: k });
  }
  return out;
}

const cursorOf = (at, n) => `${at}~${n}`;

// ── epic_state_changed from the per-Epic event logs ──

const EPIC_STATE_KIND = 'epic_state_changed';
const EPIC_STATE_EVENT = 'epic.state_changed';
const EPIC_ROOTS_TTL_MS = 10000;
const EPIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** @param {unknown} v */
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * One epic.state_changed event → its outside epic_state_changed row, or null
 * (any other kind, epic.status_changed included).
 * @param {string} cwd project root the event log belongs to
 * @param {Record<string, any>} ev a parsed event-log record
 * @param {string|null} [externalRef] fallback ref (active index) when the event carries none
 */
function epicStateRowOf(cwd, ev, externalRef = null) {
  if (!isObj(ev) || ev.kind !== EPIC_STATE_EVENT) return null;
  const at = nonEmpty(ev.time);
  const epicId = nonEmpty(ev.epicId);
  const to = nonEmpty(ev.to);
  if (!at || !epicId || !to) return null;
  /** @type {Record<string, any>} */
  const row = { at, kind: EPIC_STATE_KIND, cwd, epicId, from: ev.from ?? null, to };
  const blockedKind = to === 'blocked' ? nonEmpty(ev.blockedKind) : null;
  if (blockedKind) row.blockedKind = blockedKind;
  const ref = nonEmpty(ev.externalRef) || nonEmpty(externalRef);
  if (ref) row.externalRef = ref;
  return row;
}

/** events.jsonl path → { size, offset (end of last complete line), events } — read incrementally. */
const logCache = new Map();
/** active-index.json path → { mtimeMs, size, refs: Map<epicId, externalRef> }. */
const indexCache = new Map();
/** `${cwd}\0${epicId}` → externalRef, kept once seen (a completed Epic leaves the active index). */
const knownRefs = new Map();
let rootsCache = { at: 0, roots: /** @type {string[]} */ ([]) };

/** epic.state_changed events of one event-log file, re-reading only bytes appended since the last call. */
function statusEventsOf(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { logCache.delete(file); return []; }
  let c = logCache.get(file);
  if (!c || size < c.offset) c = { size: 0, offset: 0, events: [] };
  if (size > c.offset) {
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - c.offset);
        const n = fs.readSync(fd, buf, 0, buf.length, c.offset);
        text = buf.subarray(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return c.events; }
    const end = text.lastIndexOf('\n');
    if (end >= 0) {
      const events = c.events.slice();
      for (const line of text.slice(0, end).split('\n')) {
        if (!line.includes(EPIC_STATE_EVENT)) continue;
        try {
          const r = JSON.parse(line);
          if (isObj(r) && r.kind === EPIC_STATE_EVENT) events.push(r);
        } catch { /* torn line */ }
      }
      c = { size, offset: c.offset + Buffer.byteLength(text.slice(0, end + 1), 'utf8'), events };
    }
  }
  logCache.set(file, c);
  return c.events;
}

/** externalRef per open Epic of one project, from its active index (cached by mtime + size). */
function activeRefs(root) {
  let file;
  try { file = opsPath(root, 'prompt-sessions', 'active-index.json'); } catch { return new Map(); }
  let st;
  try { st = fs.statSync(file); } catch { return new Map(); }
  const c = indexCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.refs;
  const refs = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sessions = isObj(data) && isObj(data.sessions) ? data.sessions : {};
    for (const [id, s] of Object.entries(sessions)) {
      const ref = isObj(s) && isObj(s.source) ? nonEmpty(s.source.externalRef) : null;
      if (ref) refs.set(id, ref);
    }
  } catch { /* unreadable index → no refs */ }
  indexCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, refs });
  return refs;
}

/** Registered project roots, folded to project roots, de-duplicated. */
function defaultEpicRoots() {
  if (rootsCache.at && Date.now() - rootsCache.at < EPIC_ROOTS_TTL_MS) return rootsCache.roots;
  let raw = [];
  try { raw = require('../../promptSessionsIpc.cjs').defaultProjectRoots() || []; } catch { raw = []; }
  rootsCache = { at: Date.now(), roots: raw };
  return raw;
}

/** @param {string[]} raw */
function foldRoots(raw) {
  let rootOf = (/** @type {string} */ p) => p;
  try { const { projectRootOf } = require('../activeSessions.cjs'); rootOf = (p) => projectRootOf(p) || p; } catch { /* keep as is */ }
  const out = new Set();
  for (const r of raw) {
    if (typeof r !== 'string' || !r || !path.isAbsolute(r)) continue;
    out.add(path.resolve(rootOf(r)).replace(/[\\/]+$/, ''));
  }
  return [...out].sort();
}

/**
 * Every epic_state_changed row of the given projects, sorted by at, cwd, epicId, seq.
 * Never throws.
 * @param {string[]} roots
 */
function readEpicStateRows(roots) {
  const rows = [];
  for (const root of foldRoots(roots)) {
    let dir;
    let names;
    try { dir = opsPath(root, 'events'); names = fs.readdirSync(dir).filter((n) => EPIC_ID_RE.test(n)).sort(); } catch { continue; }
    let refs = null;
    for (const epicId of names) {
      const events = statusEventsOf(path.join(dir, epicId, 'events.jsonl'));
      if (!events.length) continue;
      const key = `${root}\0${epicId}`;
      if (!knownRefs.has(key)) {
        refs = refs || activeRefs(root);
        const ref = refs.get(epicId);
        if (ref) knownRefs.set(key, ref);
      }
      for (const ev of events) {
        const row = epicStateRowOf(root, ev, knownRefs.get(key) ?? null);
        if (row) rows.push({ row, seq: Number.isInteger(ev.seq) ? ev.seq : 0 });
      }
    }
  }
  rows.sort((a, b) => (a.row.at < b.row.at ? -1 : a.row.at > b.row.at ? 1 : 0)
    || (a.row.cwd < b.row.cwd ? -1 : a.row.cwd > b.row.cwd ? 1 : 0)
    || (a.row.epicId < b.row.epicId ? -1 : a.row.epicId > b.row.epicId ? 1 : 0)
    || a.seq - b.seq);
  return rows.map((r) => r.row);
}

/** Merge epic rows into audit rows by `at`; audit rows win ties. Both inputs sorted. */
function mergeByAt(audit, epic) {
  if (!epic.length) return audit;
  const out = [];
  let i = 0;
  let j = 0;
  while (i < audit.length || j < epic.length) {
    if (j >= epic.length || (i < audit.length && audit[i].at <= epic[j].at)) out.push(audit[i++]);
    else out.push(epic[j++]);
  }
  return out;
}

function _resetEpicStateCacheForTests() {
  logCache.clear();
  indexCache.clear();
  knownRefs.clear();
  rootsCache = { at: 0, roots: [] };
}

/**
 * @param {{ after?: string, kinds?: string[], limit?: number, target?: string, initialWindow?: number, maxArchiveGzBytes?: number, projectRoots?: () => string[] }} [opts]
 * @returns {{ events: object[], next: string, more: boolean, gap: boolean }}
 */
function readEventsAfter({ after, kinds, limit, target, initialWindow, maxArchiveGzBytes, projectRoots } = {}) {
  const file = target ?? auditLogPath();
  /** @type {object[]} */
  let epicRows = [];
  if (typeof projectRoots === 'function' || target === undefined) {
    let roots = [];
    try { roots = typeof projectRoots === 'function' ? (projectRoots() || []) : defaultEpicRoots(); } catch { roots = []; }
    epicRows = readEpicStateRows(roots);
  }
  const maxGz = Number.isFinite(maxArchiveGzBytes) && maxArchiveGzBytes >= 0 ? maxArchiveGzBytes : MAX_ARCHIVE_GZ_BYTES;
  const win = Number.isFinite(initialWindow) && initialWindow > 0 ? initialWindow : INITIAL_WINDOW;
  const kindSet = new Set(Array.isArray(kinds) && kinds.length ? kinds : DEFAULT_KINDS);
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;

  if (after === undefined || after === null) {
    const probe = parseRows(readTail(Math.min(win, 64 * 1024), file));
    if (!probe.length && fileSize(file) === 0 && !epicRows.length) return { events: [], next: START, more: false, gap: false };
    const epicLast = epicRows.length ? /** @type {{ at: string }} */ (epicRows[epicRows.length - 1]).at : null;
    let lastAt = probe.length ? probe[probe.length - 1].at : null;
    if (epicLast !== null && (lastAt === null || epicLast > lastAt)) lastAt = epicLast;
    const live = fileSize(file) === 0 ? [] : loadLive(file, lastAt, win).rows;
    const rows = mergeByAt(live, epicRows);
    if (!rows.length) return { events: [], next: START, more: false, gap: false };
    const ords = withOrdinals(rows);
    const last = ords[ords.length - 1];
    return { events: [], next: cursorOf(last.row.at, last.ord), more: false, gap: false };
  }

  const cur = parseCursor(after);
  let gap = false;
  let rows;
  if (cur.start) {
    rows = loadLive(file, null, win).rows;
  } else {
    const live = loadLive(file, cur.at, win);
    rows = live.rows;
    if (live.whole && (!rows.length || cur.at <= rows[0].at)) {
      const archive = loadArchive(file, maxGz);
      rows = archive.rows.concat(rows);
      gap = archive.skipped || (rows.length > 0 && cur.at < rows[0].at);
    }
  }
  rows = mergeByAt(rows, epicRows);

  const events = [];
  let more = false;
  let next = cur.start ? START : cursorOf(cur.at, cur.n);
  for (const { row, ord } of withOrdinals(rows)) {
    if (!cur.start && (row.at < cur.at || (row.at === cur.at && ord <= cur.n))) continue;
    if (kindSet.has(row.kind)) {
      if (events.length >= lim) { more = true; break; }
      const { caller: _caller, ...rest } = row;
      events.push(rest);
    }
    next = cursorOf(row.at, ord);
  }
  return { events, next, more, gap };
}

module.exports = {
  OUTSIDE_EVENT_KINDS, readEventsAfter, CURSOR_FORM, INVALID_AUDIT_CURSOR, MAX_ARCHIVE_GZ_BYTES,
  epicStateRowOf, _resetEpicStateCacheForTests,
};
