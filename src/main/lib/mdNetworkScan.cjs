// @ts-check
'use strict';

/**
 * mdNetworkScan.cjs — a project's markdown link network, mapped from its root
 * CLAUDE.md, for Project Home's Tools > Review MD network (link map + findings).
 * No LLM, read-only, bounded.
 *
 * Top-level in lib/ because no subfolder fits: it reads the project's own docs,
 * so it is neither project-pages/ (the generated pages/videos library) nor git/
 * (git only lists the files), and it does I/O, so it is not util/. It sits
 * beside memoryMdNetwork.cjs, the other reader of the same docs network.
 *
 * - buildMdNetwork({ files, root, exists, records }) — pure graph builder over
 *   in-memory docs; `records` paths never appear in orphan findings.
 * - scanMdNetwork(cwd, deps, opts) — thin I/O wrapper: one `git ls-files -z`, at
 *   most MAX_DOCS docs read (the root, then breadth-first along its links, then
 *   the rest shallowest-first, so the cap drops unreachable docs before reachable
 *   ones), at most MAX_DOC_BYTES each, READ_BATCH reads in parallel, async fs only.
 *   Untracked link targets (e.g. gitignored files) are checked on disk.
 *   It also attaches a per-doc census (mdDocCensus.cjs + mdDocRefs.cjs) over
 *   every tracked .md: one `git log --max-count=2000 --name-only` (64 MB buffer)
 *   for recency, one `git grep -F -o` over non-.md files (16 MB buffer) for code
 *   mentions, and at most MAX_REF_PROBES on-disk probes (READ_BATCH at a time)
 *   for backticked paths git does not vouch for — unprobed ones count as
 *   existing. A failing git call degrades to a census warning, never an error.
 *   Docs in record collections (opts.recordFolders / heuristic) leave orphans.
 *
 * Followed: inline `[text](target)` links (images too) and `<target.md>`
 * autolinks, outside code fences, inline code and HTML comments. Ignored: any
 * `scheme:` target (http(s):, mailto:, ...), `/absolute` and `//host` targets,
 * and `#anchor`-only links. `#fragment` and `?query` are stripped and the rest
 * resolves against the linking doc's folder. A target outside the project, or
 * one that does not exist, is a broken link.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execGit } = require('./git/gitExec.cjs');
const { censusMdDocs, parseGitLog } = require('./mdDocCensus.cjs');
const { backtickPaths, assessRefs, mentionPatterns, parseMentions } = require('./mdDocRefs.cjs');

const ROOT_DOC = 'CLAUDE.md';
const MAX_DOCS = 2000;
const MAX_DOC_BYTES = 256 * 1024;
const READ_BATCH = 32;
/** Longest link destination or title scanned, so a pathological line stays linear. */
const MAX_LINK_CHARS = 1024;
/** `git ls-files -z` stdout cap; node's 1 MB default overflows near 15k tracked files. */
const LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;
const LOG_ARGS = ['log', '--max-count=2000', '--no-renames', '--format=%x01%ct', '--name-only', '-z'];
const LOG_MAX_BUFFER = 64 * 1024 * 1024;
const GREP_MAX_BUFFER = 16 * 1024 * 1024;
/** On-disk probes for backticked paths git does not vouch for, per scan. */
const MAX_REF_PROBES = 500;
const OWNER_NAMES = new Set(['CLAUDE.md', 'README.md', 'AGENTS.md']);
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
const DETAIL_MISSING = 'The link target doesn’t exist.';
const DETAIL_ESCAPES = 'The link target is outside the project.';

const MD_RE = /\.md$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(`+).{0,1024}?\1/g;
const AUTOLINK_RE = /<([^<>\s]{1,1024})>/g;

/**
 * @typedef {{ path: string, text: string }} MdFile a doc: repo-relative POSIX path + text
 * @typedef {{ line: number, target: string, to: string, escapes: boolean }} MdLink
 *   `target` as written (fragment/query stripped); `to` resolved repo-relative
 * @typedef {'hub' | 'owner' | 'doc'} MdNetworkNodeType
 * @typedef {{ id: string, path: string, depth: number, type: MdNetworkNodeType, linksOut: number, linkedFrom: number }} MdNetworkNode
 * @typedef {{ from: string, to: string, broken?: boolean }} MdNetworkEdge
 *   `to` of a broken edge is the missing (or escaping) resolved target, not a node
 * @typedef {{ type: 'broken-link', file: string, line: number, target: string, to: string, where: string, detail: string }} MdNetworkBrokenLink
 * @typedef {{ type: 'orphan', where: string, count: number, paths: string[], detail: string }} MdNetworkOrphan
 * @typedef {MdNetworkBrokenLink | MdNetworkOrphan} MdNetworkFinding
 * @typedef {{ ok: true, root: string, nodes: MdNetworkNode[], edges: MdNetworkEdge[], findings: MdNetworkFinding[], docs: number, links: number, scopes: string[] }} MdLinkNetwork
 * @typedef {MdLinkNetwork | { ok: false, error: string }} MdLinkNetworkResult
 * @typedef {import('./mdDocCensus.cjs').MdCensus} MdCensus
 * @typedef {MdLinkNetwork & { census: MdCensus }} MdNetwork
 * @typedef {MdNetwork | { ok: false, error: string }} MdNetworkResult
 * @typedef {{ recordFolders?: string[], docFolders?: string[] }} ScanOpts
 * @typedef {{ fence: string, inComment: boolean }} LineState an open code fence / HTML comment
 */

/**
 * @typedef {object} ScanDeps
 * @property {(cwd: string, args: string[], opts?: { maxBuffer?: number }) => Promise<string>} [execGit]
 *   default: git/gitExec.cjs execGit
 * @property {(absPath: string, maxBytes: number) => Promise<string>} [readFile]
 *   reads at most `maxBytes` from the start of a file (default: readHead)
 * @property {(absPath: string) => Promise<boolean>} [exists] default: fs.promises.access
 */

/** @param {unknown} err @returns {string} */
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {unknown} err @param {'code' | 'stderrText'} key @returns {unknown} */
function errorField(err, key) {
  return err !== null && typeof err === 'object' ? /** @type {Record<string, unknown>} */ (err)[key] : undefined;
}

/** @param {string} a @param {string} b @returns {number} */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Repo-relative POSIX form: no `./` or trailing `/`; `.` is the root folder. @param {string} p */
function toRepoPath(p) {
  return path.posix.normalize(p).replace(/\/+$/, '') || '.';
}

/** @param {string} p @returns {string} the top-level folder, or `.` for a root-level path */
function topFolder(p) {
  const slash = p.indexOf('/');
  return slash === -1 ? '.' : p.slice(0, slash);
}

/** Every ancestor folder of `paths`. @param {Iterable<string>} paths @returns {Set<string>} */
function foldersOf(paths) {
  /** @type {Set<string>} */
  const folders = new Set();
  for (const p of paths) {
    for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
      const folder = p.slice(0, i);
      if (folders.has(folder)) break; // its ancestors are already in
      folders.add(folder);
    }
  }
  return folders;
}

/** @param {string} s @param {number} i @returns {number} the first index at or after `i` that is not a space/tab */
function skipBlanks(s, i) {
  while (s[i] === ' ' || s[i] === '\t') i += 1;
  return i;
}

/** @param {string} s @param {string} ch @param {number} from @returns {number} `ch`'s index within MAX_LINK_CHARS, or -1 */
function indexWithin(s, ch, from) {
  const i = s.slice(from, from + MAX_LINK_CHARS).indexOf(ch);
  return i === -1 ? -1 : from + i;
}

/**
 * Parses an inline link's destination (+ optional title) starting just after `](`.
 * @param {string} s
 * @param {number} start
 * @returns {{ target: string, end: number } | null} the raw target and the index after `)`
 */
function parseDestination(s, start) {
  let j = skipBlanks(s, start);
  let target;
  if (s[j] === '<') {
    const close = indexWithin(s, '>', j + 1);
    if (close === -1) return null;
    target = s.slice(j + 1, close);
    j = close + 1;
  } else {
    const from = j;
    const limit = Math.min(s.length, from + MAX_LINK_CHARS);
    let depth = 0;
    for (; j < limit; j += 1) {
      const c = s[j];
      if (c === ' ' || c === '\t') break;
      if (c === '(') depth += 1;
      else if (c === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (j === limit && j < s.length) return null;
    target = s.slice(from, j);
  }
  j = skipBlanks(s, j);
  const quote = s[j];
  if (quote === '"' || quote === "'" || quote === '(') {
    const close = indexWithin(s, quote === '(' ? ')' : quote, j + 1);
    if (close === -1) return null;
    j = skipBlanks(s, close + 1);
  }
  return s[j] === ')' ? { target, end: j + 1 } : null;
}

/** Raw targets of one line's inline links, then of its `<x.md>` autolinks. @param {string} s @returns {string[]} */
function lineTargets(s) {
  /** @type {string[]} */
  const targets = [];
  let outside = ''; // the line minus its inline links, so `[x](<a.md>)` is not also an autolink
  let last = 0;
  for (let i = s.indexOf(']('); i !== -1; ) {
    const dest = parseDestination(s, i + 2);
    if (dest) {
      targets.push(dest.target);
      outside += `${s.slice(last, i)} `;
      last = dest.end;
      i = s.indexOf('](', dest.end);
    } else {
      i = s.indexOf('](', i + 2);
    }
  }
  outside += s.slice(last);
  for (const m of outside.matchAll(AUTOLINK_RE)) {
    if (MD_RE.test(m[1].replace(/[?#].*$/, ''))) targets.push(m[1]);
  }
  return targets;
}

/** Drops HTML comments (which may span lines) from one line. @param {string} line @param {LineState} state */
function stripComments(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inComment) {
      const close = line.indexOf('-->', i);
      if (close === -1) return out;
      state.inComment = false;
      i = close + 3;
    } else {
      const open = line.indexOf('<!--', i);
      if (open === -1) return out + line.slice(i);
      out += `${line.slice(i, open)} `;
      state.inComment = true;
      i = open + 4;
    }
  }
  return out;
}

/** The part of one line that can hold links. @param {string} line @param {LineState} state @returns {string} */
function visibleText(line, state) {
  const fence = state.inComment ? null : FENCE_RE.exec(line);
  if (state.fence) {
    if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && fence[2].trim() === '') {
      state.fence = '';
    }
    return '';
  }
  if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
    state.fence = fence[1];
    return '';
  }
  return stripComments(line.replace(INLINE_CODE_RE, ' '), state);
}

/**
 * The followed link for one raw target written in doc `from`, or null when ignored.
 * @param {string} from @param {string} raw @param {number} line 1-based
 * @returns {MdLink | null}
 */
function followLink(from, raw, line) {
  const written = raw.trim();
  if (written === '' || written[0] === '#' || written[0] === '/' || SCHEME_RE.test(written)) return null;
  const target = written.replace(/[?#].*$/, '');
  if (target === '') return null;
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // a stray `%` is part of the file name
  }
  const to = toRepoPath(path.posix.join(path.posix.dirname(from), decoded));
  return { line, target, to, escapes: to === '..' || to.startsWith('../') };
}

/**
 * Memo for linksOf: scanMdNetwork walks the docs before buildMdNetwork does, so
 * each doc is parsed once. File objects are treated as immutable.
 * @type {WeakMap<MdFile, MdLink[]>}
 */
const linkMemo = new WeakMap();

/** A doc's followed links, in document order. @param {MdFile} file @returns {MdLink[]} */
function linksOf(file) {
  const memo = linkMemo.get(file);
  if (memo) return memo;
  const from = toRepoPath(file.path);
  /** @type {MdLink[]} */
  const links = [];
  /** @type {LineState} */
  const state = { fence: '', inComment: false };
  const lines = file.text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n += 1) {
    const visible = visibleText(lines[n], state);
    if (visible === '') continue;
    for (const raw of lineTargets(visible)) {
      const link = followLink(from, raw, n + 1);
      if (link) links.push(link);
    }
  }
  linkMemo.set(file, links);
  return links;
}

/** @param {string} id @param {number} depth @returns {MdNetworkNodeType} */
function nodeType(id, depth) {
  if (depth === 0) return 'hub';
  return depth === 1 && OWNER_NAMES.has(path.posix.basename(id)) ? 'owner' : 'doc';
}

/** @param {string} root @param {number} count @returns {string} */
function orphanDetail(root, count) {
  return count === 1
    ? `No link path from ${root} reaches this doc, so agents starting there never find it.`
    : `No link path from ${root} reaches these ${count} docs, so agents starting there never find them.`;
}

/** @param {string} root @returns {{ ok: false, error: string }} */
function missingRoot(root) {
  return { ok: false, error: `no ${root} at the project root` };
}

/**
 * Pure: the link network reachable from `root` over in-memory docs.
 * `exists(relPath)` vouches for link targets that are neither one of `files`
 * nor a folder holding one (code files, docs left unread, untracked files);
 * without it such targets are missing. `records` (record-collection docs, not
 * meant to be linked) are left out of orphan groups.
 * @param {{ files?: MdFile[], root?: string, exists?: (relPath: string) => boolean, records?: ReadonlySet<string> }} [input]
 * @returns {MdLinkNetworkResult}
 */
function buildMdNetwork({ files = [], root = ROOT_DOC, exists, records } = {}) {
  try {
    const rootPath = toRepoPath(root);
    /** @type {Map<string, MdFile>} */
    const docs = new Map();
    for (const file of files) {
      if (file && typeof file.path === 'string' && typeof file.text === 'string') docs.set(toRepoPath(file.path), file);
    }
    if (!docs.has(rootPath)) return missingRoot(rootPath);
    const folders = foldersOf(docs.keys());
    /** @param {string} p */
    const present = (p) => p === '.' || docs.has(p) || folders.has(p) || (exists !== undefined && exists(p) === true);

    /** @type {Map<string, number>} */
    const depth = new Map([[rootPath, 0]]);
    const order = [rootPath]; // BFS order = node order
    /** @type {MdNetworkEdge[]} */
    const edges = [];
    /** @type {MdNetworkFinding[]} */
    const findings = [];
    const edgeKeys = new Set();
    const findingKeys = new Set();
    /** @type {Map<string, number>} */
    const linksOut = new Map();
    /** @type {Map<string, number>} */
    const linkedFrom = new Map();

    for (let i = 0; i < order.length; i += 1) {
      const from = order[i];
      const file = docs.get(from);
      if (!file) continue;
      const nextDepth = (depth.get(from) ?? 0) + 1;
      for (const link of linksOf(file)) {
        const broken = link.escapes || !present(link.to);
        if (broken) {
          const where = `${from}:${link.line} → ${link.target}`;
          if (!findingKeys.has(where)) {
            findingKeys.add(where);
            const detail = link.escapes ? DETAIL_ESCAPES : DETAIL_MISSING;
            findings.push({ type: 'broken-link', file: from, line: link.line, target: link.target, to: link.to, where, detail });
          }
        } else if (link.to === from || !docs.has(link.to)) {
          continue; // a self link, or a present target that is not a doc: no edge
        }
        const edgeKey = `${from}\0${link.to}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);
        edges.push(broken ? { from, to: link.to, broken: true } : { from, to: link.to });
        linksOut.set(from, (linksOut.get(from) ?? 0) + 1);
        linkedFrom.set(link.to, (linkedFrom.get(link.to) ?? 0) + 1);
        if (!broken && !depth.has(link.to)) {
          depth.set(link.to, nextDepth);
          order.push(link.to);
        }
      }
    }

    const nodes = order.map((id) => {
      const d = depth.get(id) ?? 0;
      return { id, path: id, depth: d, type: nodeType(id, d), linksOut: linksOut.get(id) ?? 0, linkedFrom: linkedFrom.get(id) ?? 0 };
    });

    /** @type {Map<string, string[]>} */
    const orphans = new Map();
    for (const p of docs.keys()) {
      if (depth.has(p) || (records !== undefined && records.has(p))) continue;
      const top = topFolder(p);
      const group = orphans.get(top);
      if (group) group.push(p);
      else orphans.set(top, [p]);
    }
    for (const [top, paths] of [...orphans].sort(([a], [b]) => byCodeUnit(a, b))) {
      paths.sort(byCodeUnit);
      findings.push({ type: 'orphan', where: `${top}/`, count: paths.length, paths, detail: orphanDetail(rootPath, paths.length) });
    }

    const scopes = [...new Set(order.map(topFolder))].filter((t) => t !== '.').sort(byCodeUnit).map((t) => `${t}/`);
    return { ok: true, root: rootPath, nodes, edges, findings, docs: docs.size, links: edges.length, scopes };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * The first `maxBytes` of a file as UTF-8 (a character split at the cut decodes as U+FFFD).
 * @param {string} absPath @param {number} maxBytes @returns {Promise<string>}
 */
async function readHead(absPath, maxBytes) {
  const handle = await fs.promises.open(absPath, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.allocUnsafe(Math.min(size, maxBytes));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.toString('utf8', 0, filled);
  } finally {
    await handle.close();
  }
}

/** @param {string} absPath @returns {Promise<boolean>} */
function pathExists(absPath) {
  return fs.promises.access(absPath).then(
    () => true,
    () => false,
  );
}

/** The `fatal:`/`error:` line of a failed git call, else its first line. @param {unknown} err @returns {string} */
function gitFailure(err) {
  const stderr = errorField(err, 'stderrText');
  const text = (typeof stderr === 'string' && stderr.trim()) || errorText(err);
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? 'unknown error';
}

/**
 * I/O: scans the git project at `cwd` and builds its network. Never throws.
 * @param {string} cwd the project root (`git ls-files` paths are relative to it)
 * @param {ScanDeps} [deps] injectable I/O; defaults are git + async fs
 * @param {ScanOpts} [opts] record-collection overrides for the census
 * @returns {Promise<MdNetworkResult>}
 */
async function scanMdNetwork(cwd, deps = {}, opts = {}) {
  try {
    if (typeof cwd !== 'string' || cwd === '') return { ok: false, error: 'cwd must be a non-empty path' };
    /** @type {NonNullable<ScanDeps['execGit']>} */
    const runGit = deps.execGit ?? execGit;
    const readFile = deps.readFile ?? readHead;
    const exists = deps.exists ?? pathExists;

    let listing;
    try {
      listing = await runGit(cwd, ['ls-files', '-z'], { maxBuffer: LS_FILES_MAX_BUFFER });
    } catch (err) {
      return { ok: false, error: `git ls-files failed: ${gitFailure(err)}` };
    }
    const tracked = String(listing)
      .split('\0')
      .filter((p) => p !== '');
    const trackedSet = new Set(tracked);
    const trackedFolders = foldersOf(tracked);
    const docPaths = tracked.filter((p) => MD_RE.test(p));
    const docSet = new Set(docPaths);

    /** @type {Set<string>} docs whose read was started; never more than MAX_DOCS */
    const attempted = new Set();
    /** @type {Set<string>} tracked docs missing on disk (deleted, not yet committed) */
    const gone = new Set();

    /** @param {string} rel @returns {Promise<MdFile | null>} */
    const readOne = async (rel) => {
      attempted.add(rel);
      try {
        const text = await readFile(path.join(cwd, rel), MAX_DOC_BYTES);
        return { path: rel, text: typeof text === 'string' ? text.slice(0, MAX_DOC_BYTES) : '' };
      } catch (err) {
        if (MISSING_CODES.has(String(errorField(err, 'code')))) gone.add(rel);
        else if (rel === ROOT_DOC) throw err;
        return null; // an unreadable doc is skipped; links to it still count as present
      }
    };
    /** @param {string[]} rels @returns {Promise<MdFile[]>} */
    const readAll = async (rels) => {
      /** @type {MdFile[]} */
      const read = [];
      for (let i = 0; i < rels.length; i += READ_BATCH) {
        for (const file of await Promise.all(rels.slice(i, i + READ_BATCH).map(readOne))) {
          if (file) read.push(file);
        }
      }
      return read;
    };

    // The root is read straight from disk, so an untracked CLAUDE.md still counts.
    const rootFile = await readOne(ROOT_DOC);
    if (!rootFile) return missingRoot(ROOT_DOC);

    // Breadth-first along links, so the cap never drops a reachable doc for an
    // unreachable one; collect targets git does not vouch for along the way.
    const files = [rootFile];
    const queued = new Set([ROOT_DOC]);
    /** @type {Set<string>} */
    const unvouched = new Set();
    for (let wave = [rootFile]; wave.length > 0; ) {
      /** @type {string[]} */
      const next = [];
      for (const file of wave) {
        for (const link of linksOf(file)) {
          if (link.escapes || queued.has(link.to)) continue;
          if (docSet.has(link.to)) {
            queued.add(link.to);
            next.push(link.to);
          } else if (link.to !== '.' && !trackedSet.has(link.to) && !trackedFolders.has(link.to)) {
            unvouched.add(link.to);
          }
        }
      }
      wave = await readAll(next.slice(0, Math.max(0, MAX_DOCS - attempted.size)));
      files.push(...wave);
    }

    // The rest, shallowest first (stable sort keeps git's path order), for orphans.
    const room = MAX_DOCS - attempted.size;
    if (room > 0) {
      const rest = docPaths
        .filter((p) => !attempted.has(p))
        .map((p) => ({ p, d: p.split('/').length }))
        .sort((a, b) => a.d - b.d)
        .slice(0, room)
        .map(({ p }) => p);
      files.push(...(await readAll(rest)));
    }

    // Untracked link targets (e.g. gitignored files) are checked on disk.
    /** @type {Set<string>} */
    const onDisk = new Set();
    const candidates = [...unvouched];
    /** @param {string} rel @returns {Promise<boolean>} */
    const probe = async (rel) => {
      try {
        return (await exists(path.join(cwd, rel))) === true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < candidates.length; i += READ_BATCH) {
      const batch = candidates.slice(i, i + READ_BATCH);
      const hits = await Promise.all(batch.map(probe));
      batch.forEach((rel, k) => {
        if (hits[k]) onDisk.add(rel);
      });
    }

    /** @param {string} p */
    const vouched = (p) => !gone.has(p) && (trackedSet.has(p) || trackedFolders.has(p));
    /** @param {string} p */
    const present = (p) => onDisk.has(p) || vouched(p);
    const network = buildMdNetwork({ files, root: ROOT_DOC, exists: present });
    if (!network.ok) return network;

    // ── Census ──
    /** @type {string[]} */
    const warnings = [];

    // Recency: one capped git log; newest first, so the first sighting wins.
    /** @type {import('./mdDocCensus.cjs').GitLogEntry[]} */
    let log = [];
    try {
      const out = String(await runGit(cwd, LOG_ARGS, { maxBuffer: LOG_MAX_BUFFER }));
      log = parseGitLog(out);
      if (log.length === 0 && out.trim() !== '') warnings.push('git history unavailable: unparseable git log output');
    } catch (err) {
      warnings.push(`git history unavailable: ${gitFailure(err)}`);
    }
    /** @type {Map<string, number>} */
    const lastCommit = new Map();
    for (const entry of log) {
      for (const f of entry.files) if (!lastCommit.has(f)) lastCommit.set(f, entry.ms);
    }
    /** @param {string} p */
    const lastCommitOf = (p) => lastCommit.get(p) ?? null;

    /** @type {Map<string, { depth: number, linkedFrom: number }>} */
    const reachable = new Map(network.nodes.map((n) => [n.path, { depth: n.depth, linkedFrom: n.linkedFrom }]));
    /** @type {Map<string, MdFile>} */
    const readByPath = new Map(files.map((f) => [f.path, f]));

    // Backticked paths git does not vouch for: probed on disk, capped; the rest count as existing.
    /** @type {Map<string, boolean>} */
    const probed = new Map();
    /** @type {string[]} */
    const toProbe = [];
    const queuedProbes = new Set();
    /** @type {Map<MdFile, string[]>} */
    const tokensOf = new Map();
    for (const file of files) {
      const tokens = backtickPaths(file.text);
      tokensOf.set(file, tokens);
      const dir = path.posix.dirname(file.path);
      for (const tok of tokens) {
        const rootForm = toRepoPath(tok);
        const forms = dir === '.' ? [rootForm] : [rootForm, toRepoPath(path.posix.join(dir, tok))];
        for (const rel of forms) {
          if (rel === '.' || rel === '..' || rel.startsWith('../')) continue;
          if (vouched(rel)) break; // assessRefs takes the first existing form
          if (onDisk.has(rel) || queuedProbes.has(rel) || toProbe.length >= MAX_REF_PROBES) continue;
          queuedProbes.add(rel);
          toProbe.push(rel);
        }
      }
    }
    for (let i = 0; i < toProbe.length; i += READ_BATCH) {
      const batch = toProbe.slice(i, i + READ_BATCH);
      const hits = await Promise.all(batch.map(probe));
      batch.forEach((rel, k) => probed.set(rel, hits[k]));
    }
    /** @param {string} p */
    const refExists = (p) => {
      if (present(p)) return true;
      if (gone.has(p)) return false;
      const hit = probed.get(p);
      return hit === undefined ? true : hit;
    };

    /** @type {Map<string, import('./mdDocCensus.cjs').MdDocRefs>} */
    const refs = new Map();
    for (const file of files) {
      const linkTargets = linksOf(file)
        .filter((l) => !l.escapes && present(l.to))
        .map((l) => l.to);
      refs.set(
        file.path,
        assessRefs({
          docPath: file.path,
          linkTargets,
          tokens: tokensOf.get(file) ?? [],
          docMs: lastCommitOf(file.path),
          exists: refExists,
          lastCommitOf,
        }),
      );
    }

    // Code mentions: one git grep over every non-.md tracked file.
    /** @type {Map<string, string[]>} */
    let codeMentions = new Map();
    const { patterns, owner } = mentionPatterns(docPaths);
    if (patterns.length > 0) {
      const grepArgs = ['grep', '--no-color', '-I', '-F', '-o', '--null', ...patterns.flatMap((p) => ['-e', p]), '--', '.', ':(exclude)*.md'];
      try {
        codeMentions = parseMentions(String(await runGit(cwd, grepArgs, { maxBuffer: GREP_MAX_BUFFER })), owner);
      } catch (err) {
        const stderr = errorField(err, 'stderrText');
        const noMatches = errorField(err, 'code') === 1 && !(typeof stderr === 'string' && stderr.trim() !== '');
        if (!noMatches) warnings.push(`code mentions unavailable: ${gitFailure(err)}`);
      }
    }

    const docs = docPaths.map((p) => {
      const file = readByPath.get(p);
      if (!file) return { path: p, text: null, lines: null, bytes: null };
      const { text } = file;
      return { path: p, text, lines: text === '' ? 0 : text.split('\n').length, bytes: Buffer.byteLength(text) };
    });
    const census = censusMdDocs({
      root: ROOT_DOC,
      docs,
      reachable,
      log,
      refs,
      codeMentions,
      recordFolders: opts.recordFolders,
      docFolders: opts.docFolders,
    });
    census.warnings.unshift(...warnings);

    const records = new Set(census.docs.filter((d) => d.role === 'record').map((d) => d.path));
    if (records.size === 0) return { ...network, census };
    const pruned = buildMdNetwork({ files, root: ROOT_DOC, exists: present, records });
    return pruned.ok ? { ...pruned, census } : pruned;
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

module.exports = { buildMdNetwork, scanMdNetwork };
