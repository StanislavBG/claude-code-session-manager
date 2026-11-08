#!/usr/bin/env node
'use strict';
/**
 * drift-check.cjs — dependency-free drift check for a repo's markdown network.
 *
 *   node drift-check.cjs [--root <dir>] [--map <path>] [--file <path>]...
 *                        [--exclude <prefix>]... [--checks links,paths,limits,contents] [--strict-paths]
 *
 * Prints one JSON object { root, map, notes, findings, counts, checkedFiles } to stdout.
 * Exit 0 = no findings, 1 = findings, 2 = usage error / missing root.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ALL_CHECKS = ['links', 'paths', 'limits', 'contents'];
const LIMIT_ALWAYS_LOADED = 200;
const LIMIT_MAP = 70;
const CONTENTS_MIN_LINES = 100;
const CONTENTS_WINDOW = 60;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { root: null, map: null, files: [], excludes: [], checks: ALL_CHECKS.slice(), strictPaths: false };
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

/** Blank out inline code spans (keeps length) so links inside them are ignored. */
function blankCode(line) {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

const IGNORE_MARKER = '<!-- drift-check-ignore -->';
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

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

/** Parse a doc once: returns { lines, links, spans }. */
function parseDoc(text) {
  const rawLines = text.split('\n');
  const links = [];
  const spans = [];
  const importTokens = [];
  const ignoredLines = new Set();
  let fence = null;
  let inComment = false;
  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const fm = /^\s*(```+|~~~+)/.exec(raw);
    if (!inComment && fm) {
      const marker = fm[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;
    if (raw.includes(IGNORE_MARKER)) ignoredLines.add(lineNo);
    // strip HTML comments (possibly spanning lines)
    let line = '';
    let rest = raw;
    while (rest.length) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) { rest = ''; break; }
        rest = rest.slice(end + 3);
        inComment = false;
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) { line += rest; rest = ''; break; }
        line += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
      }
    }
    const noCode = blankCode(line);
    const linkRe = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
    let m;
    while ((m = linkRe.exec(noCode))) {
      let t = m[1];
      if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
      links.push({ line: lineNo, target: t });
    }
    const impRe = /(?:^|\s)@(\S+)/g;
    while ((m = impRe.exec(noCode))) importTokens.push(m[1]);
    const spanRe = /`([^`]+)`/g;
    while ((m = spanRe.exec(line))) spans.push({ line: lineNo, span: m[1].trim() });
  });
  return { lines: rawLines, links, spans, importTokens, ignoredLines };
}

const MAX_IMPORT_HOPS = 4;

/** Claude Code `@path` imports of a doc: absolute .md paths inside root. */
function parseImports(text, fileAbs, root) {
  const out = [];
  for (let tok of parseDoc(text).importTokens) {
    tok = tok.replace(/[.,;:!?)\]}'"]+$/, '');
    if (!tok || tok.startsWith('~')) continue;
    if (!/\.md$/i.test(tok)) continue;
    const abs = path.resolve(path.dirname(fileAbs), tok);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
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
  const opts = Object.assign({ root: null, map: null, files: [], excludes: [], checks: ALL_CHECKS, strictPaths: false }, options);
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

  for (const rel of docs) {
    const abs = path.join(root, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
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
