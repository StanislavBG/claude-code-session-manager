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
 * - buildMdNetwork({ files, root, exists, localOnly, records, loadedByTools, history })
 *   — pure graph builder over in-memory docs. Docs a tool loads by name
 *   (LOADED_BY_TOOLS, any `/skills/` folder, the GitHub root files, plus
 *   `loadedByTools` prefixes) are entry points, never orphans. `history`
 *   prefixes and `records` docs are never walked: a link into one is an edge
 *   and the doc a leaf node, but its own links pull nothing in; they are never
 *   orphans either.
 * - scanMdNetwork(cwd, deps) — thin I/O wrapper: one `git ls-files -z`, at
 *   most MAX_DOCS docs read (the root, then breadth-first along its links, then
 *   the rest shallowest-first, so the cap drops unreachable docs before reachable
 *   ones), at most MAX_DOC_BYTES each, READ_BATCH reads in parallel, async fs only.
 *   A link target git does not track is a broken link in every checkout; it is
 *   flagged localOnly when it is gitignored (one `git check-ignore --no-index`
 *   per 100 targets) or present on disk here.
 *   Optional `mdNetwork.loadedByTools` / `mdNetwork.history` string-prefix
 *   arrays come from the project's tracked .session-manager.json.
 *   It also attaches a per-doc census (mdDocCensus.cjs + mdDocRefs.cjs) over
 *   every tracked .md: one `git log --max-count=2000 --name-only` (64 MB buffer)
 *   for recency, one `git grep -F -o` over non-.md files (16 MB buffer) for code
 *   mentions, and at most MAX_REF_PROBES on-disk probes (READ_BATCH at a time)
 *   for backticked paths git does not vouch for — unprobed ones count as
 *   existing. A probed-absent path that is gitignored (same check-ignore pass
 *   as link targets) is never dead; one naming exactly one tracked file or
 *   folder by suffix (`lib/x.ts`) resolves to it, two or more make it an
 *   ambiguousRef. A failing git call degrades to a census warning, never an error.
 *   `duplicates` is mdDuplicates.findDuplicates over every read doc except
 *   history prefixes and record-collection docs; a failure degrades to [] plus
 *   a census warning.
 *   Docs in record collections (the census heuristic) leave orphans.
 *
 * Followed — every reference an agent follows, matching the maintaining-md-network
 * skill's link convention: inline `[text](target)` links (images too) and
 * `<target.md>` autolinks, outside code fences, inline code and HTML comments;
 * backticked `path.md` tokens (outside fences and comments) resolved repo-root
 * first, then against the doc's folder; and `@path.md` imports resolved against
 * the doc's folder. For links, ignored: any `scheme:` target (http(s):, mailto:,
 * ...), `/absolute` and `//host` targets, and `#anchor`-only links; `#fragment`
 * and `?query` are stripped and the rest resolves against the linking doc's
 * folder; a target outside the project, or one that does not exist, is a broken
 * link. A backticked path or import is an edge only when it resolves to a doc;
 * one that resolves to nothing is never a broken link (the census lists dead
 * backticked paths as deadRefs). Backticked non-.md paths are never edges.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execGit } = require('./git/gitExec.cjs');
const { censusMdDocs, parseGitLog, recordCollectionDocs } = require('./mdDocCensus.cjs');
const { assessRefs, suffixIndex, mentionPatterns, parseMentions } = require('./mdDocRefs.cjs');
// The link convention (links, imports, backticked paths) is written once, in the skill's mdLinks.cjs.
const { linksOf, importsOf, backtickPaths, toRepoPath } = require('../../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdLinks.cjs');
// Called through the module object (mdDuplicates.findDuplicates), so a test can stub it.
const mdDuplicates = require('../../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdDuplicates.cjs');

const ROOT_DOC = 'CLAUDE.md';
const MAX_DOCS = 2000;
const MAX_DOC_BYTES = 256 * 1024;
const READ_BATCH = 32;
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
const DETAIL_LOCAL_ONLY = 'Works only on this machine: the target is not tracked in git.';
const CONFIG_FILE = '.session-manager.json';
const CHECK_IGNORE_BATCH = 100;

/**
 * Doc prefixes a tool loads by name (agents, plugin packs, seeds, GitHub files):
 * entry points, never orphans. The doc-hierarchy lint's EXEMPT_PREFIXES calls
 * these "tool-loaded", "seeded" and "github".
 */
const LOADED_BY_TOOLS = Object.freeze(['.claude/', '.github/', 'plugins/', 'src/seed/']);
/** Root files GitHub (or a contributor) opens by name. */
const LOADED_BY_TOOLS_ROOT_FILES = new Set(['README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md']);

const MD_RE = /\.md$/i;

/**
 * @typedef {import('../../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdLinks.cjs').MdFile} MdFile
 * @typedef {import('../../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdLinks.cjs').MdLink} MdLink
 * @typedef {MdLink & { kind: 'link' | 'path' | 'import' }} MdRef a followed reference; only `link` ones can be broken
 *   `target` as written (fragment/query stripped); `to` resolved repo-relative
 * @typedef {'hub' | 'owner' | 'doc'} MdNetworkNodeType
 * @typedef {{ id: string, path: string, depth: number, type: MdNetworkNodeType, linksOut: number, linkedFrom: number }} MdNetworkNode
 * @typedef {{ from: string, to: string, broken?: boolean }} MdNetworkEdge
 *   `to` of a broken edge is the missing (or escaping) resolved target, not a node
 * @typedef {{ type: 'broken-link', file: string, line: number, target: string, to: string, where: string, detail: string, localOnly?: boolean }} MdNetworkBrokenLink
 *   `localOnly`: the target is not tracked but is gitignored or on disk here
 * @typedef {{ type: 'orphan', where: string, count: number, paths: string[], detail: string }} MdNetworkOrphan
 * @typedef {MdNetworkBrokenLink | MdNetworkOrphan} MdNetworkFinding
 * @typedef {{ ok: true, root: string, nodes: MdNetworkNode[], edges: MdNetworkEdge[], findings: MdNetworkFinding[], docs: number, links: number, scopes: string[] }} MdLinkNetwork
 * @typedef {MdLinkNetwork | { ok: false, error: string }} MdLinkNetworkResult
 * @typedef {import('./mdDocCensus.cjs').MdCensus} MdCensus
 * @typedef {{ a: string, b: string, sharedRuns: number, samples: string[], copy?: true }} MdDuplicatePair
 * @typedef {MdLinkNetwork & { census: MdCensus, duplicates: MdDuplicatePair[] }} MdNetwork
 * @typedef {MdNetwork | { ok: false, error: string }} MdNetworkResult
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

/**
 * Memo for refsOf's doc-independent parse: backticked `.md` tokens and `@` imports.
 * @type {WeakMap<MdFile, { tokens: string[], imports: string[] }>}
 */
const pathRefMemo = new WeakMap();

/**
 * A doc's followed references: its markdown links (kind `link`, as linksOf),
 * then its `@` imports and backticked `.md` paths that resolve to a doc per
 * `isDoc` (kinds `import` / `path`, line 0). A backticked token tries the
 * repo-root form first, then the doc-relative one.
 * @param {MdFile} file @param {(relPath: string) => boolean} isDoc
 * @returns {MdRef[]}
 */
function refsOf(file, isDoc) {
  const from = toRepoPath(file.path);
  let parsed = pathRefMemo.get(file);
  if (!parsed) {
    parsed = {
      tokens: backtickPaths(file.text).filter((t) => t.endsWith('.md')),
      imports: importsOf(file.text, from),
    };
    pathRefMemo.set(file, parsed);
  }
  /** @type {MdRef[]} */
  const refs = linksOf(file).map((l) => ({ ...l, kind: /** @type {const} */ ('link') }));
  for (const imp of parsed.imports) {
    const to = toRepoPath(imp);
    if (isDoc(to)) refs.push({ line: 0, target: imp, to, escapes: false, kind: 'import' });
  }
  const dir = path.posix.dirname(from);
  for (const tok of parsed.tokens) {
    const forms = dir === '.' ? [toRepoPath(tok)] : [toRepoPath(tok), toRepoPath(path.posix.join(dir, tok))];
    const to = forms.find((f) => f !== '..' && !f.startsWith('../') && isDoc(f));
    if (to !== undefined) refs.push({ line: 0, target: tok, to, escapes: false, kind: 'path' });
  }
  return refs;
}

/** @param {unknown} list @returns {string[]} the non-empty strings of `list` */
function prefixList(list) {
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p !== '') : [];
}

/** @param {string} p @param {readonly string[]} prefixes */
function hasPrefix(p, prefixes) {
  return prefixes.some((pre) => p.startsWith(pre));
}

/** A doc a tool loads by name. @param {string} p @param {readonly string[]} extra */
function isLoadedByTools(p, extra) {
  return LOADED_BY_TOOLS_ROOT_FILES.has(p) || p.startsWith('skills/') || p.includes('/skills/') || hasPrefix(p, LOADED_BY_TOOLS) || hasPrefix(p, extra);
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
 * without it such targets are missing. A missing target `localOnly` vouches
 * for (untracked here, e.g. gitignored) is a broken link flagged localOnly.
 * `records` (record-collection docs) and `history` prefixes are never walked
 * and never orphans; docs a tool loads by name (LOADED_BY_TOOLS + `loadedByTools`
 * prefixes) are never orphans.
 * @param {{ files?: MdFile[], root?: string, exists?: (relPath: string) => boolean, localOnly?: (relPath: string) => boolean, records?: ReadonlySet<string>, loadedByTools?: string[], history?: string[] }} [input]
 * @returns {MdLinkNetworkResult}
 */
function buildMdNetwork({ files = [], root = ROOT_DOC, exists, localOnly, records, loadedByTools, history } = {}) {
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
    /** @param {string} p */
    const isDoc = (p) => docs.has(p);
    const historyPrefixes = prefixList(history);
    const toolPrefixes = prefixList(loadedByTools);
    /** A doc whose own links are never followed. @param {string} p */
    const isLeaf = (p) => p !== rootPath && ((records !== undefined && records.has(p)) || hasPrefix(p, historyPrefixes));

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
      if (!file || isLeaf(from)) continue;
      const nextDepth = (depth.get(from) ?? 0) + 1;
      for (const link of refsOf(file, isDoc)) {
        const broken = link.kind === 'link' && (link.escapes || !present(link.to));
        if (broken) {
          const where = `${from}:${link.line} → ${link.target}`;
          if (!findingKeys.has(where)) {
            findingKeys.add(where);
            const local = !link.escapes && localOnly !== undefined && localOnly(link.to) === true;
            const detail = link.escapes ? DETAIL_ESCAPES : local ? DETAIL_LOCAL_ONLY : DETAIL_MISSING;
            /** @type {MdNetworkBrokenLink} */
            const finding = { type: 'broken-link', file: from, line: link.line, target: link.target, to: link.to, where, detail };
            if (local) finding.localOnly = true;
            findings.push(finding);
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
      if (depth.has(p) || isLeaf(p) || isLoadedByTools(p, toolPrefixes)) continue;
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

/**
 * The project's optional mdNetwork prefixes from its tracked .session-manager.json.
 * @param {string} cwd @param {boolean} tracked
 * @returns {Promise<{ loadedByTools: string[], history: string[], warning: string | null }>}
 */
async function readNetworkConfig(cwd, tracked) {
  const none = { loadedByTools: [], history: [], warning: null };
  if (!tracked) return none;
  let text;
  try {
    text = await fs.promises.readFile(path.join(cwd, CONFIG_FILE), 'utf8');
  } catch (err) {
    if (MISSING_CODES.has(String(errorField(err, 'code')))) return none;
    return { ...none, warning: `${CONFIG_FILE} unreadable, mdNetwork settings ignored: ${errorText(err)}` };
  }
  try {
    const parsed = JSON.parse(text);
    const net = parsed !== null && typeof parsed === 'object' ? parsed.mdNetwork : undefined;
    if (net === undefined) return none;
    if (net === null || typeof net !== 'object' || Array.isArray(net)) throw new Error('mdNetwork is not an object');
    for (const key of ['loadedByTools', 'history']) {
      const v = net[key];
      if (v !== undefined && !(Array.isArray(v) && v.every((p) => typeof p === 'string'))) throw new Error(`mdNetwork.${key} is not a string array`);
    }
    return { loadedByTools: prefixList(net.loadedByTools), history: prefixList(net.history), warning: null };
  } catch (err) {
    return { ...none, warning: `${CONFIG_FILE} unreadable, mdNetwork settings ignored: ${errorText(err)}` };
  }
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
 * @returns {Promise<MdNetworkResult>}
 */
async function scanMdNetwork(cwd, deps = {}) {
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
    const config = await readNetworkConfig(cwd, trackedSet.has(CONFIG_FILE));
    const { loadedByTools, history } = config;

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
    /** @param {string} p */
    const isDocPath = (p) => docSet.has(p);
    for (let wave = [rootFile]; wave.length > 0; ) {
      /** @type {string[]} */
      const next = [];
      for (const file of wave) {
        if (file.path !== ROOT_DOC && hasPrefix(file.path, history)) continue; // history docs are never walked
        for (const link of refsOf(file, isDocPath)) {
          if (link.escapes || queued.has(link.to)) continue;
          if (docSet.has(link.to)) {
            queued.add(link.to);
            next.push(link.to);
          } else if (link.kind === 'link' && link.to !== '.' && !trackedSet.has(link.to) && !trackedFolders.has(link.to)) {
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

    // Untracked link targets: on disk here, or gitignored, they work only on this machine.
    /** @type {Set<string>} */
    const onDisk = new Set();
    /** @type {Set<string>} */
    const ignored = new Set();
    /** @type {string[]} */
    const warnings = [];
    if (config.warning) warnings.push(config.warning);
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

    // Backticked paths git does not vouch for: probed on disk, capped; the rest count as existing.
    /** @type {Map<string, boolean>} */
    const probed = new Map();
    /** @type {string[]} */
    const toProbe = [];
    const queuedProbes = new Set();
    /** @type {Set<string>} probed forms of `folder/` tokens */
    const folderRefs = new Set();
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
          if (tok.endsWith('/')) folderRefs.add(rel);
        }
      }
    }
    for (let i = 0; i < toProbe.length; i += READ_BATCH) {
      const batch = toProbe.slice(i, i + READ_BATCH);
      const hits = await Promise.all(batch.map(probe));
      batch.forEach((rel, k) => probed.set(rel, hits[k]));
    }
    const notOnDisk = candidates.filter((rel) => !onDisk.has(rel));
    // One check-ignore pass for absent link targets and absent backticked refs;
    // a folder ref is asked with its trailing '/' so dir-only patterns match.
    const toCheck = [...new Set([...notOnDisk, ...toProbe.filter((rel) => probed.get(rel) === false).map((rel) => (folderRefs.has(rel) ? `${rel}/` : rel))])];
    checkIgnore: for (let i = 0; i < toCheck.length; i += CHECK_IGNORE_BATCH) {
      let batch = toCheck.slice(i, i + CHECK_IGNORE_BATCH);
      while (batch.length > 0) {
        try {
          // -z needs --stdin, so paths go as args and come back one per line, unquoted.
          const out = String(await runGit(cwd, ['-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--', ...batch]));
          for (const rel of out.split('\n')) if (rel !== '') ignored.add(toRepoPath(rel));
          break;
        } catch (err) {
          if (errorField(err, 'code') === 1) break;
          // A path under a symlink (a linked node_modules) fails the whole call: drop it, retry the rest.
          const beyond = /pathspec '(.+)' is beyond a symbolic link/.exec(gitFailure(err));
          const drop = beyond ? batch.indexOf(beyond[1]) : -1;
          if (drop >= 0) {
            batch = batch.filter((_, k) => k !== drop);
            continue;
          }
          warnings.push(`gitignore check unavailable: ${gitFailure(err)}`);
          break checkIgnore;
        }
      }
    }

    /** @param {string} p */
    const present = (p) => vouched(p);
    /** @param {string} p */
    const localOnly = (p) => onDisk.has(p) || ignored.has(p);
    const networkInput = { files, root: ROOT_DOC, exists: present, localOnly, loadedByTools, history };
    const network = buildMdNetwork(networkInput);
    if (!network.ok) return network;

    // ── Census ──

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

    /** @param {string} p */
    const refExists = (p) => {
      if (present(p) || onDisk.has(p)) return true;
      if (gone.has(p)) return false;
      const hit = probed.get(p);
      return hit === undefined ? true : hit;
    };

    // Shorthand refs (`lib/x.ts`) resolve by suffix against everything git tracks here.
    const suffixMatches = suffixIndex([...tracked.filter((p) => !gone.has(p)), ...trackedFolders]);
    /** @type {Map<string, import('./mdDocCensus.cjs').MdDocRefs>} */
    const refs = new Map();
    for (const file of files) {
      const linkTargets = linksOf(file)
        .filter((l) => !l.escapes && (present(l.to) || onDisk.has(l.to)))
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
          ignored: (p) => ignored.has(p),
          suffixMatches,
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
    });
    census.warnings.unshift(...warnings);

    // Record-collection docs leave orphans and are never walked, linked or not.
    const records = new Set(recordCollectionDocs(census));

    // Duplication over living docs only: never history, never record collections.
    /** @type {MdDuplicatePair[]} */
    let duplicates = [];
    try {
      const living = files.filter((f) => f.path === ROOT_DOC || (!records.has(f.path) && !hasPrefix(f.path, history)));
      duplicates = mdDuplicates.findDuplicates(living);
    } catch (err) {
      census.warnings.push(`duplicates unavailable: ${errorText(err)}`);
    }

    if (records.size === 0) return { ...network, census, duplicates };
    const pruned = buildMdNetwork({ ...networkInput, records });
    return pruned.ok ? { ...pruned, census, duplicates } : pruned;
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

module.exports = { buildMdNetwork, scanMdNetwork, LOADED_BY_TOOLS };
