// @ts-check
'use strict';

/**
 * mdDocCensus.cjs — a per-doc census of a project's tracked markdown: how agents
 * meet each doc (role), whether it sits in a machine-written record collection,
 * and when git last changed it. Pure — no I/O; the Review MD network scan runs
 * git, reads the docs and hands the results in.
 *
 * Top-level in lib/ because no subfolder fits: it sits beside mdNetworkScan.cjs,
 * the reader of the same docs network, and like it is neither project-pages/
 * nor git/ (it only parses git's output) nor util/ (it is domain logic).
 *
 * - censusMdDocs(input) — roles, record collections, recency, counts.
 * - parseGitLog(stdout) — `git log --max-count=2000 --no-renames
 *   --format=%x01%ct --name-only -z` stdout -> newest-first { ms, files }.
 * - importsOf(text, fromPath) — the path.md imports (at-sign prefixed) a doc makes.
 *
 * Roles, by precedence: map (the root + its transitive imports, depth <= 5)
 * > scoped (any other CLAUDE.md / AGENTS.md / CLAUDE.local.md) > agent
 * (.claude/, skills/<x>/, plugins/<x>/agents|commands/) > record (in a record
 * collection, unreachable, not a README/CLAUDE/AGENTS/index) > doc.
 *
 * Never throws on malformed input: invalid entries are skipped.
 */

const path = require('node:path');

const ROOT_DOC = 'CLAUDE.md';
const MAX_IMPORT_DEPTH = 5;
const COLLECTION_MIN_DOCS = 20;
const COLLECTION_MAX_LINKED_SHARE = 0.05;
const WRITE_ONCE_MAX_COMMITS = 2;
const WRITE_ONCE_MIN_SHARE = 0.8;
const MAX_CODE_REF_FILES = 10;
const MAX_DEAD_REFS = 10;
const MAX_CHANGED_SINCE = 20;

const MD_RE = /\.md$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(`+).{0,1024}?\1/g;
const IMPORT_RE = /(^|\s)@(\S+)/g;
const TRAILING_PUNCT_RE = /[),.;:!?'"\]]+$/;
const AGENT_RE = /(^|\/)\.claude\/|(^|\/)skills\/[^/]+\/|(^|\/)plugins\/[^/]+\/(agents|commands)\//;
const SCOPED_NAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md']);
const NEVER_RECORD_NAMES = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md', 'index.md']);

/**
 * @typedef {'map' | 'scoped' | 'agent' | 'record' | 'doc'} MdDocRole
 * @typedef {{ path: string, ms: number }} MdChangedSince
 * @typedef {{ path: string, role: MdDocRole, depth: number | null, lines: number | null, bytes: number | null, lastCommitMs: number | null, commits: number, linkedFrom: number, codeRefs: number, codeRefFiles: string[], deadRefs: string[], changedSince: MdChangedSince[], collection: string | null }} MdDoc
 * @typedef {{ folder: string, docs: number, linked: number, lastCommitMs: number | null, source: 'heuristic' | 'override' }} MdRecordCollection
 * @typedef {{ tracked: number, network: number, records: number, unlinked: number, byRole: Record<MdDocRole, number> }} MdCensusCounts
 * @typedef {{ docs: MdDoc[], collections: MdRecordCollection[], counts: MdCensusCounts, gitWindow: { commits: number, oldestMs: number | null }, warnings: string[] }} MdCensus
 * @typedef {{ path: string, text?: string | null, lines?: number | null, bytes?: number | null }} MdCensusDocInput
 * @typedef {{ ms: number, files: string[] }} GitLogEntry
 * @typedef {{ deadRefs: string[], changedSince: MdChangedSince[] }} MdDocRefs
 * @typedef {object} CensusInput
 * @property {string} [root] the root doc (default CLAUDE.md)
 * @property {MdCensusDocInput[]} docs every tracked .md, repo-relative POSIX
 * @property {Map<string, { depth: number, linkedFrom: number }>} reachable docs links reach from the root
 * @property {GitLogEntry[]} [log] newest first
 * @property {Map<string, MdDocRefs>} [refs]
 * @property {Map<string, string[]>} [codeMentions] doc path -> code files naming it
 * @property {string[]} [recordFolders] folders forced to be record collections
 * @property {string[]} [docFolders] folders (and subfolders) never record collections
 */

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @param {unknown} v @returns {number | null} */
function numOrNull(v) {
  return isFiniteNumber(v) ? v : null;
}

/** @param {string} p @returns {string} the last path segment */
function baseName(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Folder form with a trailing slash, or '' for the repo root / invalid. @param {unknown} f @returns {string} */
function toFolder(f) {
  if (typeof f !== 'string') return '';
  const norm = path.posix.normalize(f.trim()).replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!norm || norm === '.' || norm.startsWith('../') || norm === '..' || norm.startsWith('/')) return '';
  return `${norm}/`;
}

/** Every ancestor folder of `p`, shallowest first, each with a trailing slash. @param {string} p @returns {string[]} */
function foldersOf(p) {
  /** @type {string[]} */
  const out = [];
  for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i + 1));
  return out;
}

/**
 * The `@path.md` imports in `text`, outside fenced and inline code, resolved
 * against `fromPath`'s folder. Skips `@~/...`, absolute and escaping targets.
 * @param {string} text @param {string} fromPath @returns {string[]}
 */
function importsOf(text, fromPath) {
  if (typeof text !== 'string' || typeof fromPath !== 'string') return [];
  const dir = path.posix.dirname(fromPath);
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  let fence = '';
  for (const line of text.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = '';
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      continue;
    }
    const visible = line.replace(INLINE_CODE_RE, ' ');
    for (const m of visible.matchAll(IMPORT_RE)) {
      const target = m[2].replace(TRAILING_PUNCT_RE, '');
      if (!MD_RE.test(target) || target.startsWith('~') || target.startsWith('/')) continue;
      const resolved = path.posix.normalize(path.posix.join(dir, target));
      if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

/**
 * Parse `git log --max-count=2000 --no-renames --format=%x01%ct --name-only -z`.
 * @param {string} stdout @returns {GitLogEntry[]} newest first; [] when empty or unparseable
 */
function parseGitLog(stdout) {
  if (typeof stdout !== 'string' || !stdout.includes('\x01')) return [];
  /** @type {GitLogEntry[]} */
  const out = [];
  const chunks = stdout.split('\x01');
  for (let i = 1; i < chunks.length; i += 1) {
    const m = /^(\d+)/.exec(chunks[i]);
    if (!m) continue;
    const ms = Number(m[1]) * 1000;
    if (!Number.isFinite(ms)) continue;
    const files = chunks[i]
      .slice(m[1].length)
      .split(/[\0\n]/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    out.push({ ms, files });
  }
  return out;
}

/** @param {unknown} list @param {number} cap @returns {string[]} */
function stringList(list, cap) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => typeof s === 'string').slice(0, cap);
}

/** @param {unknown} list @returns {MdChangedSince[]} */
function changedSinceList(list) {
  if (!Array.isArray(list)) return [];
  /** @type {MdChangedSince[]} */
  const out = [];
  for (const e of list) {
    if (out.length >= MAX_CHANGED_SINCE) break;
    if (e && typeof e === 'object' && typeof e.path === 'string' && isFiniteNumber(e.ms)) out.push({ path: e.path, ms: e.ms });
  }
  return out;
}

/**
 * The census of a project's tracked docs.
 * @param {CensusInput} input @returns {MdCensus}
 */
function censusMdDocs(input) {
  const {
    root = ROOT_DOC,
    docs = [],
    reachable = new Map(),
    log = [],
    refs,
    codeMentions,
    recordFolders = [],
    docFolders = [],
  } = input || /** @type {CensusInput} */ ({ docs: [], reachable: new Map() });
  /** @type {string[]} */
  const warnings = [];

  // Valid, distinct docs in input order.
  /** @type {MdCensusDocInput[]} */
  const list = [];
  const seen = new Set();
  let invalid = 0;
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || typeof d !== 'object' || typeof d.path !== 'string' || d.path === '') {
      invalid += 1;
      continue;
    }
    if (seen.has(d.path)) {
      warnings.push(`Duplicate doc skipped: ${d.path}`);
      continue;
    }
    seen.add(d.path);
    list.push(d);
  }
  if (invalid > 0) warnings.push(`${invalid} invalid doc entr${invalid === 1 ? 'y' : 'ies'} skipped.`);
  const reach = reachable instanceof Map ? reachable : new Map();

  // Recency.
  /** @type {Map<string, { last: number, commits: number }>} */
  const recency = new Map();
  let windowCommits = 0;
  /** @type {number | null} */
  let oldestMs = null;
  for (const e of Array.isArray(log) ? log : []) {
    if (!e || typeof e !== 'object' || !isFiniteNumber(e.ms) || !Array.isArray(e.files)) continue;
    windowCommits += 1;
    oldestMs = oldestMs === null ? e.ms : Math.min(oldestMs, e.ms);
    for (const f of new Set(e.files)) {
      if (typeof f !== 'string') continue;
      const r = recency.get(f);
      if (r) {
        r.commits += 1;
        r.last = Math.max(r.last, e.ms);
      } else recency.set(f, { last: e.ms, commits: 1 });
    }
  }

  // Map: root + transitive @-imports.
  /** @type {Map<string, string | null | undefined>} */
  const textOf = new Map(list.map((d) => [d.path, d.text]));
  const mapSet = new Set();
  if (typeof root === 'string' && textOf.has(root)) {
    mapSet.add(root);
    let frontier = [root];
    for (let depth = 1; depth <= MAX_IMPORT_DEPTH && frontier.length > 0; depth += 1) {
      /** @type {string[]} */
      const next = [];
      for (const from of frontier) {
        const text = textOf.get(from);
        if (typeof text !== 'string') continue;
        for (const to of importsOf(text, from)) {
          if (!textOf.has(to) || mapSet.has(to)) continue;
          mapSet.add(to);
          next.push(to);
        }
      }
      frontier = next;
    }
  }
  /** @param {string} p */
  const isReachable = (p) => reach.has(p) || mapSet.has(p);

  // Record collections.
  const blocked = (Array.isArray(docFolders) ? docFolders : []).map(toFolder).filter(Boolean);
  /** @param {string} folder */
  const isBlocked = (folder) => blocked.some((b) => folder.startsWith(b));
  /** @type {Map<string, { docs: number, linked: number, withCommits: number, writeOnce: number, last: number | null }>} */
  const stats = new Map();
  for (const d of list) {
    const r = recency.get(d.path);
    for (const folder of foldersOf(d.path)) {
      let s = stats.get(folder);
      if (!s) {
        s = { docs: 0, linked: 0, withCommits: 0, writeOnce: 0, last: null };
        stats.set(folder, s);
      }
      s.docs += 1;
      if (isReachable(d.path)) s.linked += 1;
      if (r) {
        s.withCommits += 1;
        if (r.commits <= WRITE_ONCE_MAX_COMMITS) s.writeOnce += 1;
        s.last = s.last === null ? r.last : Math.max(s.last, r.last);
      }
    }
  }
  /** @type {MdRecordCollection[]} */
  const collections = [];
  /** @param {string} folder */
  const insideChosen = (folder) => collections.some((c) => folder.startsWith(c.folder));
  const overrides = [...new Set((Array.isArray(recordFolders) ? recordFolders : []).map(toFolder).filter(Boolean))].sort(
    (a, b) => a.length - b.length,
  );
  for (const folder of overrides) {
    if (insideChosen(folder)) continue;
    const s = stats.get(folder);
    if (!s) warnings.push(`Record folder override matches no doc: ${folder}`);
    collections.push({ folder, docs: s ? s.docs : 0, linked: s ? s.linked : 0, lastCommitMs: s ? s.last : null, source: 'override' });
  }
  const candidates = [...stats.keys()].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  for (const folder of candidates) {
    if (isBlocked(folder) || insideChosen(folder) || overrides.some((o) => o.startsWith(folder))) continue;
    const s = /** @type {NonNullable<ReturnType<typeof stats.get>>} */ (stats.get(folder));
    if (s.docs < COLLECTION_MIN_DOCS || s.linked > s.docs * COLLECTION_MAX_LINKED_SHARE) continue;
    if (s.withCommits > 0 && s.writeOnce < s.withCommits * WRITE_ONCE_MIN_SHARE) continue;
    collections.push({ folder, docs: s.docs, linked: s.linked, lastCommitMs: s.last, source: 'heuristic' });
  }
  collections.sort((a, b) => b.docs - a.docs || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
  /** @param {string} p @returns {string | null} */
  const collectionOf = (p) => {
    const c = collections.find((col) => p.startsWith(col.folder));
    return c ? c.folder : null;
  };

  // Per-doc rows.
  /** @type {Record<MdDocRole, number>} */
  const byRole = { map: 0, scoped: 0, agent: 0, record: 0, doc: 0 };
  let network = 0;
  let unlinked = 0;
  /** @type {MdDoc[]} */
  const out = [];
  for (const d of list) {
    const p = d.path;
    const name = baseName(p);
    const hit = reach.get(p);
    const depth = hit && isFiniteNumber(hit.depth) ? hit.depth : null;
    const reachableDoc = isReachable(p);
    const folder = collectionOf(p);
    /** @type {MdDocRole} */
    let role = 'doc';
    if (mapSet.has(p)) role = 'map';
    else if (SCOPED_NAMES.has(name)) role = 'scoped';
    else if (AGENT_RE.test(p)) role = 'agent';
    else if (folder && !reachableDoc && !NEVER_RECORD_NAMES.has(name)) role = 'record';
    byRole[role] += 1;
    if (reachableDoc) network += 1;
    if (role === 'doc' && depth === null) unlinked += 1;
    const r = recency.get(p);
    const mentions = codeMentions instanceof Map ? stringList(codeMentions.get(p), Infinity) : [];
    const ref = refs instanceof Map ? refs.get(p) : undefined;
    out.push({
      path: p,
      role,
      depth,
      lines: numOrNull(d.lines),
      bytes: numOrNull(d.bytes),
      lastCommitMs: r ? r.last : null,
      commits: r ? r.commits : 0,
      linkedFrom: hit && isFiniteNumber(hit.linkedFrom) ? hit.linkedFrom : 0,
      codeRefs: mentions.length,
      codeRefFiles: mentions.slice(0, MAX_CODE_REF_FILES),
      deadRefs: ref ? stringList(ref.deadRefs, MAX_DEAD_REFS) : [],
      changedSince: ref ? changedSinceList(ref.changedSince) : [],
      collection: role === 'record' ? folder : null,
    });
  }

  return {
    docs: out,
    collections,
    counts: { tracked: out.length, network, records: byRole.record, unlinked, byRole },
    gitWindow: { commits: windowCommits, oldestMs },
    warnings,
  };
}

module.exports = { censusMdDocs, parseGitLog, importsOf };
