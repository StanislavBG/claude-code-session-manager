// @ts-check
'use strict';

/**
 * mdReviewRecord.cjs — reads the review record the maintaining-md-network skill
 * commits (session-manager-operations/reviews/docs/<YYYY-MM-DD>-md-network.md,
 * a second record on one date taking -2, -3, ...), so Project Home can show
 * what a review produced. Read-only: fs.promises reads only, never a write, so
 * reading reviews/ needs no ownership change.
 *
 * Top-level in lib/ because no subfolder fits: like mdNetworkScan.cjs (which it
 * sits beside), it reads the same project's own review docs, so it is neither
 * project-pages/ (the generated pages library) nor git/, and it does I/O, so it
 * is not util/.
 *
 * - newestRecordName(names) — pure: the newest record file name, or null.
 * - parseReviewRecord(text) — pure: the template fields; never throws.
 * - readMdReview(root, { epicIds }) — newest record + validation record paths
 *   for each safe Epic id, read from disk in plan-records/<epicId>/ (the
 *   machine-local, never-committed namespace) merged with the legacy
 *   reviews/validation/<epicId>/ history. On a file-name clash the
 *   plan-records copy wins.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { opsPath, resolveProjectRoot } = require('./opsOwnership.cjs');

const RECORD_RE = /^(\d{4}-\d{2}-\d{2})-md-network(?:-(\d+))?\.md$/;
const EPIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;
const MAX_RECORD_BYTES = 256 * 1024;

/**
 * @typedef {{ doc: string, verdict: string, owner: string }} ReviewVerdict
 * @typedef {{
 *   date: string | null,
 *   mode: string | null,
 *   modeKind: 'Full review' | 'Drift check' | null,
 *   scope: string | null,
 *   session: string | null,
 *   baseCommit: string | null,
 *   owner: string | null,
 *   map: string | null,
 *   driftCheckCommand: string | null,
 *   findingsCounts: Record<string, number>,
 *   censusSummary: string | null,
 *   verdicts: ReviewVerdict[],
 *   decisions: string[],
 *   followUpPrds: string[],
 *   nextReviewDue: string | null,
 *   nextReviewNote: string | null,
 * }} ReviewRecord
 * @typedef {{
 *   ok: true,
 *   record: ReviewRecord | null,
 *   recordPath: string | null,
 *   validation: Record<string, string[]>,
 * }} MdReviewOk
 * @typedef {{ ok: false, error: string }} MdReviewErr
 */

/**
 * The newest review record name: newest date first, then the highest numeric
 * suffix (-10 beats -9; any suffix beats none). Non-matching names are ignored.
 * @param {readonly string[]} names
 * @returns {string | null}
 */
function newestRecordName(names) {
  /** @type {{ name: string, date: string, n: number } | null} */
  let best = null;
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string') continue;
    const m = RECORD_RE.exec(name);
    if (!m) continue;
    const date = m[1];
    const n = m[2] ? Number(m[2]) : 0;
    if (!best || date > best.date || (date === best.date && n > best.n)) best = { name, date, n };
  }
  return best ? best.name : null;
}

/** @type {Record<string, 'date' | 'mode' | 'scope' | 'session' | 'baseCommit' | 'owner' | 'map' | 'driftCheckCommand' | 'censusSummary'>} */
const FIELD_KEYS = {
  date: 'date',
  mode: 'mode',
  scope: 'scope',
  session: 'session',
  'base commit': 'baseCommit',
  owner: 'owner',
  map: 'map',
  'drift-check command': 'driftCheckCommand',
  'census summary': 'censusSummary',
};

/** @param {string} line @returns {string[] | null} */
function tableCells(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const inner = t.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

/** @param {string} s */
function listItem(s) {
  const m = /^\s*[-*]\s+(.*)$/.exec(s);
  return m ? m[1].trim() : null;
}

/**
 * Parse a review record. Missing fields are null or empty; never throws.
 * @param {unknown} text
 * @returns {ReviewRecord}
 */
function parseReviewRecord(text) {
  /** @type {ReviewRecord} */
  const rec = {
    date: null,
    mode: null,
    modeKind: null,
    scope: null,
    session: null,
    baseCommit: null,
    owner: null,
    map: null,
    driftCheckCommand: null,
    findingsCounts: {},
    censusSummary: null,
    verdicts: [],
    decisions: [],
    followUpPrds: [],
    nextReviewDue: null,
    nextReviewNote: null,
  };
  const src = typeof text === 'string' ? text : '';
  /** @type {string | null} */
  let section = null;
  /** @type {string[]} */
  const nextLines = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      section = h[1].trim().toLowerCase();
      continue;
    }
    if (/^#\s/.test(line)) continue;
    if (section === null) {
      const f = /^\s*[-*]\s+([^:]+):\s*(.*)$/.exec(line);
      if (!f) continue;
      const key = f[1].trim().toLowerCase();
      const value = f[2].trim();
      if (key === 'findings counts') {
        for (const part of value.split(',')) {
          const m = /^\s*([A-Za-z][\w-]*)\s+(\d+)\s*$/.exec(part);
          if (m) rec.findingsCounts[m[1]] = Number(m[2]);
        }
        continue;
      }
      const field = FIELD_KEYS[key];
      if (!field || !value) continue;
      rec[field] = value;
      continue;
    }
    if (section === 'verdicts') {
      const cells = tableCells(line);
      if (!cells || cells.length < 3) continue;
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
      if (cells[0].toLowerCase() === 'doc' && cells[1].toLowerCase() === 'verdict') continue;
      if (!cells[0] || !cells[1]) continue;
      rec.verdicts.push({ doc: cells[0], verdict: cells[1], owner: cells.slice(2).join(' | ') });
    } else if (section === 'decisions') {
      const item = listItem(line);
      if (item) rec.decisions.push(item);
    } else if (section === 'follow-up prds') {
      const item = listItem(line);
      if (item && item.toLowerCase() !== 'none' && item.toLowerCase() !== '"none"') rec.followUpPrds.push(item);
    } else if (section === 'next review due') {
      if (line.trim()) nextLines.push(line.trim());
    }
  }
  if (rec.mode) {
    if (/^full review\b/i.test(rec.mode)) rec.modeKind = 'Full review';
    else if (/^drift check\b/i.test(rec.mode)) rec.modeKind = 'Drift check';
  }
  if (nextLines.length) {
    const note = nextLines.join(' ');
    rec.nextReviewNote = note;
    const d = DATE_RE.exec(note);
    rec.nextReviewDue = d ? d[0] : null;
  }
  return rec;
}

/**
 * @param {string} dir
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Read at most MAX_RECORD_BYTES of a file as utf8.
 * @param {string} file
 * @returns {Promise<string | null>}
 */
async function readCapped(file) {
  /** @type {import('node:fs/promises').FileHandle | null} */
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(MAX_RECORD_BYTES);
    let total = 0;
    while (total < MAX_RECORD_BYTES) {
      const { bytesRead } = await fh.read(buf, total, MAX_RECORD_BYTES - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buf.subarray(0, total).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** @param {string} root @param {string} abs */
function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * The project's newest markdown-network review record plus its validation
 * record paths for the given Epic ids. A missing folder gives record null.
 * @param {string} root project root (absolute)
 * @param {{ epicIds?: readonly string[] }} [opts]
 * @returns {Promise<MdReviewOk | MdReviewErr>}
 */
async function readMdReview(root, opts = {}) {
  /** @type {string} */
  let projectRoot;
  /** @type {string} */
  let docsDir;
  /** @type {string} */
  let planRecordsDir;
  /** @type {string} */
  let legacyValidationDir;
  try {
    projectRoot = resolveProjectRoot(root);
    docsDir = opsPath(root, 'reviews', 'docs');
    planRecordsDir = opsPath(root, 'plan-records');
    legacyValidationDir = opsPath(root, 'reviews', 'validation');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const entries = await listDir(docsDir);
  const name = newestRecordName(entries.filter((e) => e.isFile()).map((e) => e.name));
  /** @type {ReviewRecord | null} */
  let record = null;
  /** @type {string | null} */
  let recordPath = null;
  if (name) {
    const abs = path.join(docsDir, name);
    const text = await readCapped(abs);
    if (text !== null) {
      record = parseReviewRecord(text);
      recordPath = rel(projectRoot, abs);
    }
  }

  /** @type {Record<string, string[]>} */
  const validation = {};
  const ids = Array.isArray(opts.epicIds) ? opts.epicIds : [];
  for (const id of ids) {
    if (typeof id !== 'string' || !EPIC_ID_RE.test(id) || validation[id]) continue;
    /** @type {Map<string, string>} file name -> repo-relative path */
    const byName = new Map();
    // plan-records first so its copy wins a name clash with the legacy folder.
    for (const base of [planRecordsDir, legacyValidationDir]) {
      const dir = path.join(base, id);
      for (const e of await listDir(dir)) {
        if (!e.isFile() || !e.name.endsWith('.md') || byName.has(e.name)) continue;
        byName.set(e.name, rel(projectRoot, path.join(dir, e.name)));
      }
    }
    // Ordered by file name so the last entry is the newest record (the
    // renderer's pickValidationPath takes the last one).
    validation[id] = [...byName.keys()].sort().map((n) => /** @type {string} */ (byName.get(n)));
  }

  return { ok: true, record, recordPath, validation };
}

module.exports = { newestRecordName, parseReviewRecord, readMdReview, MAX_RECORD_BYTES };
