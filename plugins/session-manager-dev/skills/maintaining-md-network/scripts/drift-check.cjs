#!/usr/bin/env node
'use strict';
/**
 * drift-check.cjs — dependency-free drift check for a repo's markdown network.
 *
 *   node drift-check.cjs [--root <dir>] [--map <path>] [--file <path>]...
 *                        [--exclude <prefix>]... [--checks links,paths,limits,contents[,orphans][,duplicates]] [--strict-paths]
 *
 * `orphans` is opt-in (not in the default set): docs no chain of references from the root
 * CLAUDE.md reaches, by the maintaining-md-network SKILL.md link convention. `duplicates` is opt-in
 * too: pairs of checked docs sharing the same text, from mdDuplicates.findDuplicates (the function
 * the app's src/main/lib/mdNetworkScan.cjs runs).
 *
 * Prints one JSON object { root, map, notes, findings, counts, checkedFiles } to stdout.
 * Exit 0 = no findings, 1 = findings, 2 = usage error / missing root.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// The link convention (links, imports, backticked paths; code and comments skipped) is written
// once, in the sibling mdLinks.cjs — same folder, so this script stays dependency-free.
const { linksOf, rawLinksOf, visibleLine, importsOf, backtickPaths, toRepoPath } = require('./mdLinks.cjs');
const { findDuplicates } = require('./mdDuplicates.cjs');

const ALL_CHECKS = ['links', 'paths', 'limits', 'contents', 'orphans', 'duplicates'];
const DEFAULT_CHECKS = ['links', 'paths', 'limits', 'contents'];
const LIMIT_ALWAYS_LOADED = 200;
const LIMIT_MAP = 70;
const CONTENTS_MIN_LINES = 100;
const CONTENTS_WINDOW = 60;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { root: null, map: null, files: [], excludes: [], checks: DEFAULT_CHECKS.slice(), strictPaths: false };
  const needValue = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new UsageError(`missing value for ${flag}`);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = needValue(i++, a);
    else if (a === '--map') opts.map = needValue(i++, a);
    else if (a === '--file') opts.files.push(needValue(i++, a));
    else if (a === '--exclude') opts.excludes.push(needValue(i++, a));
    else if (a === '--strict-paths') opts.strictPaths = true;
    else if (a === '--checks') {
      const list = needValue(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
      for (const c of list) {
        if (!ALL_CHECKS.includes(c)) throw new UsageError(`unknown check: ${c}`);
      }
      if (list.length === 0) throw new UsageError('empty --checks');
      opts.checks = list;
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  return opts;
}

const toPosix = (p) => p.split(path.sep).join('/');

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(toPosix(path.relative(root, full)));
  }
}

function listTracked(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (!r.error && r.status === 0) return r.stdout.split('\0').filter(Boolean);
  const out = [];
  walkAll(root, root, out);
  return out;
}

function walkAll(root, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(root, full, out);
    else if (e.isFile()) out.push(toPosix(path.relative(root, full)));
  }
}

function listDocs(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md'], { encoding: 'utf8' });
  if (!r.error && r.status === 0) {
    return { git: true, files: r.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f))) };
  }
  const out = [];
  walk(root, root, out);
  return { git: false, files: out };
}

const IGNORE_MARKER = '<!-- drift-check-ignore -->';
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SPAN_RE = /`([^`]+)`/g;

function isRepoPathCandidate(span) {
  if (!span.includes('/')) return false;
  if (/[\s*?<>{}|=$]/.test(span)) return false;
  if (/^[~/@]/.test(span)) return false;
  if (SCHEME_RE.test(span)) return false;
  if (/(\.\.\.|…)$/.test(span)) return false;
  if (span.split('/').some((seg) => seg === '...' || seg === '…')) return false;
  const first = span.split('/')[0];
  if (DOMAIN_RE.test(first)) return false;
  return true;
}

/**
 * Parse a doc once for the links / paths / contents checks: its lines, every link destination
 * as written (mdLinks.rawLinksOf), the inline code spans on lines outside fences and comments
 * (mdLinks.visibleLine), and the lines carrying the ignore marker.
 */
function parseDoc(text) {
  const lines = text.split('\n');
  const spans = [];
  const ignoredLines = new Set();
  const state = { fence: '', inComment: false };
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (raw.includes(IGNORE_MARKER)) ignoredLines.add(lineNo);
    for (const m of visibleLine(raw, state).matchAll(SPAN_RE)) spans.push({ line: lineNo, span: m[1].trim() });
  });
  const links = rawLinksOf(text).map((l) => ({ line: l.line, target: l.raw }));
  return { lines, links, spans, ignoredLines };
}

const MAX_IMPORT_HOPS = 4;

const escapesRoot = (p) => p === '..' || p.startsWith('../') || p.startsWith('/');

/**
 * Docs a doc references, by SKILL.md's link convention (mdLinks.cjs, shared with the app's
 * src/main/lib/mdNetworkScan.cjs): markdown links and `<x.md>` autolinks and `@path.md`
 * imports resolved against the doc's folder; backticked `.md` paths, repo-root form first,
 * then doc-relative. Only targets that are docs (per `isDoc`) count.
 */
function docRefs(from, text, isDoc) {
  const dir = path.posix.dirname(from);
  const out = [];
  const add = (to) => { if (to !== from && !out.includes(to)) out.push(to); };
  for (const l of linksOf({ path: from, text })) {
    if (!l.escapes && isDoc(l.to)) add(l.to);
  }
  for (const to of importsOf(text, from)) {
    if (isDoc(to)) add(to);
  }
  for (const tok of backtickPaths(text)) {
    if (!tok.endsWith('.md')) continue;
    const forms = dir === '.' ? [toRepoPath(tok)] : [toRepoPath(tok), toRepoPath(path.posix.join(dir, tok))];
    const to = forms.find((f) => !escapesRoot(f) && isDoc(f));
    if (to !== undefined) add(to);
  }
  return out;
}

/** Every doc reachable from the root CLAUDE.md over docRefs, BFS. */
function reachableDocs(root, allDocs) {
  const docSet = new Set(allDocs);
  docSet.add(ROOT_DOC);
  const isDoc = (p) => docSet.has(p);
  const seen = new Set([ROOT_DOC]);
  const queue = [ROOT_DOC];
  while (queue.length) {
    const from = queue.shift();
    let text;
    try { text = fs.readFileSync(path.join(root, from), 'utf8'); } catch { continue; }
    for (const to of docRefs(from, text, isDoc)) {
      if (!seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  return seen;
}

const ROOT_DOC = 'CLAUDE.md';

/** Claude Code `@path` imports of a doc (mdLinks.importsOf): absolute .md paths inside root. */
function parseImports(text, fileAbs, root) {
  const from = toPosix(path.relative(root, fileAbs));
  return importsOf(text, from).map((rel) => path.join(root, rel));
}

const docInfoCache = new Map(); // abs -> { lines, imports } | null (per process; reset each run)

function docInfo(fileAbs, root) {
  if (docInfoCache.has(fileAbs)) return docInfoCache.get(fileAbs);
  let info = null;
  try {
    const text = fs.readFileSync(fileAbs, 'utf8');
    info = { lines: countLines(text), imports: parseImports(text, fileAbs, root) };
  } catch { /* missing target: ignored */ }
  docInfoCache.set(fileAbs, info);
  return info;
}

/** Own lines + lines of recursively imported .md files (<= 4 hops, each file once). */
function expandedLineCount(fileAbs, root, seen = new Set(), depth = 0) {
  if (seen.has(fileAbs)) return 0;
  const info = docInfo(fileAbs, root);
  if (!info) return 0;
  seen.add(fileAbs);
  let total = info.lines;
  if (depth < MAX_IMPORT_HOPS) {
    for (const imp of info.imports) total += expandedLineCount(imp, root, seen, depth + 1);
  }
  return total;
}

const countLines = (text) => {
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
};

function hasContentsList(lines) {
  if (lines.some((l) => /^#{1,6}\s+(table of contents|contents)\s*#*\s*$/i.test(l))) return true;
  const n = lines.slice(0, CONTENTS_WINDOW).filter((l) => /^\s*(?:[-*+]|\d+[.)])\s.*\]\(#/.test(l)).length;
  return n >= 3;
}

function hasPathsFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!m && /^paths\s*:/m.test(m[1]);
}

function runDriftCheck(options) {
  const opts = Object.assign({ root: null, map: null, files: [], excludes: [], checks: DEFAULT_CHECKS, strictPaths: false }, options);
  const root = path.resolve(opts.root || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new UsageError(`root is not a directory: ${root}`);
  }
  const checks = new Set(opts.checks);
  docInfoCache.clear();

  let docs;
  let isGit;
  if (opts.files.length) {
    docs = opts.files.map((f) => toPosix(path.relative(root, path.resolve(root, f))));
    isGit = spawnSync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;
  } else {
    const l = listDocs(root);
    docs = l.files;
    isGit = l.git;
  }
  const excludes = opts.excludes.map((e) => toPosix(e).replace(/^\.\//, ''));
  docs = docs.filter((f) => !excludes.some((e) => f.startsWith(e))).sort();
  docs = docs.filter((f) => fs.existsSync(path.join(root, f)));

  // map
  let map = null;
  if (opts.map) {
    map = toPosix(path.relative(root, path.resolve(root, opts.map)));
    if (!fs.existsSync(path.join(root, map))) throw new UsageError(`map not found: ${opts.map}`);
  } else {
    const rootFiles = ['CLAUDE.md', 'AGENTS.md'].map((n) => path.join(root, n)).filter((p) => fs.existsSync(p));
    const candidates = [...rootFiles];
    for (const p of rootFiles) {
      const info = docInfo(p, root);
      for (const imp of info ? info.imports : []) if (!candidates.includes(imp)) candidates.push(imp);
    }
    for (const p of candidates) {
      let t;
      try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (/<!--\s*md-network-map/.test(t)) { map = toPosix(path.relative(root, p)); break; }
    }
  }
  const notes = [];
  if (map === null) notes.push('no md-network-map comment found; the 70-line map limit was not applied');

  let trackedList = null;
  const tracked = () => (trackedList || (trackedList = listTracked(root)));
  const findings = [];
  const missing = []; // { file, line, target, cands }
  const missingLinks = []; // same shape; broken-link candidates, dropped when gitignored
  const dupDocs = []; // { path, text } of every checked doc, for the duplicates check

  for (const rel of docs) {
    const abs = path.join(root, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (checks.has('duplicates')) dupDocs.push({ path: rel, text });
    const docDir = path.dirname(abs);
    const needParse = checks.has('links') || checks.has('paths') || checks.has('contents');
    const parsed = needParse ? parseDoc(text) : null;
    const lineCount = countLines(text);

    if (checks.has('links')) {
      for (const l of parsed.links) {
        if (parsed.ignoredLines.has(l.line)) continue;
        let t = l.target;
        if (t.startsWith('#') || t.startsWith('//') || SCHEME_RE.test(t)) continue;
        if (/\{\{|\}\}|\$\{|<[^>]*>/.test(t)) continue; // template placeholder, not a path
        t = t.replace(/[#?].*$/, '');
        if (!t) continue;
        try { t = decodeURI(t); } catch { /* keep raw */ }
        const fromRoot = path.resolve(root, t.replace(/^\/+/, ''));
        const siteRoute = /^\/(?!\/)/.test(t) && !fs.existsSync(fromRoot);
        if (siteRoute && !opts.strictPaths) continue;
        if (!fs.existsSync(path.resolve(docDir, t)) && !fs.existsSync(fromRoot)) {
          const cands = [path.resolve(docDir, t), fromRoot]
            .map((p) => toPosix(path.relative(root, p)))
            .filter((p) => p && !p.startsWith('..'));
          missingLinks.push({ file: rel, line: l.line, target: l.target, cands });
        }
      }
    }

    if (checks.has('paths')) {
      for (const s of parsed.spans) {
        if (parsed.ignoredLines.has(s.line)) continue;
        if (!isRepoPathCandidate(s.span)) continue;
        const t = s.span.replace(/:\d+(?:-\d+)?$/, '');
        if (!t || !t.includes('/')) continue;
        const a = path.resolve(root, t);
        const b = path.resolve(docDir, t);
        if (fs.existsSync(a) || fs.existsSync(b)) continue;
        const segs = t.split('/').filter(Boolean);
        const last = segs[segs.length - 1] || '';
        const anchored = /\.[A-Za-z0-9]+$/.test(last) || t.endsWith('/') || fs.existsSync(path.join(root, segs[0] || ''));
        if (!anchored) continue;
        const tt = t.replace(/\/+$/, '');
        const matches = tracked().filter((f) => f === tt || f.endsWith('/' + tt) || f.startsWith(tt + '/') || f.includes('/' + tt + '/'));
        if (matches.length) {
          if (opts.strictPaths) {
            findings.push({ kind: 'unanchored-path', file: rel, line: s.line, target: s.span, matches: matches.slice(0, 3) });
          }
          continue;
        }
        const cands = [a, b]
          .map((p) => toPosix(path.relative(root, p)) + (t.endsWith('/') ? '/' : ''))
          .filter((p) => p && !p.startsWith('..'));
        missing.push({ file: rel, line: s.line, target: s.span, cands });
      }
    }

    if (checks.has('limits')) {
      const base = path.posix.basename(rel);
      const isRule = /(^|\/)\.claude\/rules\/.+\.md$/.test(rel) && !hasPathsFrontmatter(text);
      const alwaysLoaded = base === 'CLAUDE.md' || base === 'AGENTS.md' || isRule;
      const isMap = !!map && rel === map;
      if (alwaysLoaded || isMap) {
        const expandedLines = expandedLineCount(abs, root);
        if (alwaysLoaded && expandedLines > LIMIT_ALWAYS_LOADED) {
          findings.push({ kind: 'over-line-limit', file: rel, lines: lineCount, expandedLines, limit: LIMIT_ALWAYS_LOADED });
        }
        if (isMap && expandedLines > LIMIT_MAP) {
          findings.push({ kind: 'over-line-limit', file: rel, lines: lineCount, expandedLines, limit: LIMIT_MAP });
        }
      }
    }

    if (checks.has('contents') && lineCount > CONTENTS_MIN_LINES && !hasContentsList(parsed.lines)) {
      findings.push({ kind: 'no-contents-list', file: rel, lines: lineCount });
    }
  }

  if (missing.length || missingLinks.length) {
    let ignored = new Set();
    if (isGit) {
      const input = [...new Set([...missing, ...missingLinks].flatMap((m) => m.cands))].join('\n') + '\n';
      const r = spawnSync('git', ['-C', root, 'check-ignore', '--stdin'], { input, encoding: 'utf8' });
      if (!r.error) ignored = new Set(r.stdout.split('\n').filter(Boolean));
    }
    for (const m of missing) {
      if (m.cands.some((c) => ignored.has(c))) continue;
      findings.push({ kind: 'missing-path', file: m.file, line: m.line, target: m.target });
    }
    for (const m of missingLinks) {
      if (m.cands.some((c) => ignored.has(c))) continue;
      findings.push({ kind: 'broken-link', file: m.file, line: m.line, target: m.target });
    }
  }

  if (checks.has('orphans')) {
    if (!fs.existsSync(path.join(root, ROOT_DOC))) {
      notes.push(`no root ${ROOT_DOC}; the orphans check was skipped`);
    } else {
      const reached = reachableDocs(root, listDocs(root).files);
      for (const rel of docs) if (!reached.has(rel)) findings.push({ kind: 'orphan', file: rel });
    }
  }

  if (checks.has('duplicates')) {
    for (const d of findDuplicates(dupDocs)) {
      const what = d.copy ? 'is a full copy of' : `shares ${d.sharedRuns} 8-word runs with`;
      findings.push({
        kind: 'duplicate',
        type: 'duplicate',
        file: d.a,
        other: d.b,
        sharedRuns: d.sharedRuns,
        detail: `${d.a} ${what} ${d.b}; keep the text in one and link to it from the other.`,
      });
    }
  }

  findings.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : (x.line || 0) - (y.line || 0)));
  const counts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1;
  // checkedFiles last: a long file list must not push findings and counts out of a truncated view.
  return { root: toPosix(root), map, notes, findings, counts, checkedFiles: docs };
}

// Set process.exitCode, never process.exit(): stdout/stderr to a pipe are async on POSIX, and
// process.exit() drops whatever has not drained (a report cut at the 64 KiB pipe buffer).
function main() {
  let result;
  try {
    result = runDriftCheck(parseArgs(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`drift-check: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.findings.length ? 1 : 0;
}

module.exports = { runDriftCheck, parseArgs };

if (require.main === module) main();
