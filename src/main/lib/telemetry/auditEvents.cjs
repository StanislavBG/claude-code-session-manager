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
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { auditLogPath, readTail } = require('./auditLog.cjs');

const OUTSIDE_EVENT_KINDS = Object.freeze(['epic_state_changed', 'job_transition']);
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

/**
 * @param {{ after?: string, kinds?: string[], limit?: number, target?: string, initialWindow?: number, maxArchiveGzBytes?: number }} [opts]
 * @returns {{ events: object[], next: string, more: boolean, gap: boolean }}
 */
function readEventsAfter({ after, kinds, limit, target, initialWindow, maxArchiveGzBytes } = {}) {
  const file = target ?? auditLogPath();
  const maxGz = Number.isFinite(maxArchiveGzBytes) && maxArchiveGzBytes >= 0 ? maxArchiveGzBytes : MAX_ARCHIVE_GZ_BYTES;
  const win = Number.isFinite(initialWindow) && initialWindow > 0 ? initialWindow : INITIAL_WINDOW;
  const kindSet = new Set(Array.isArray(kinds) && kinds.length ? kinds : DEFAULT_KINDS);
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;

  if (after === undefined || after === null) {
    const probe = parseRows(readTail(Math.min(win, 64 * 1024), file));
    if (!probe.length && fileSize(file) === 0) return { events: [], next: START, more: false, gap: false };
    const lastAt = probe.length ? probe[probe.length - 1].at : null;
    const { rows } = loadLive(file, lastAt, win);
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

module.exports = { OUTSIDE_EVENT_KINDS, readEventsAfter, CURSOR_FORM, INVALID_AUDIT_CURSOR, MAX_ARCHIVE_GZ_BYTES };
