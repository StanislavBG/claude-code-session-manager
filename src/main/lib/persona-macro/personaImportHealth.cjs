'use strict';

/**
 * personaImportHealth.cjs — integrity check for Claude Code's `@path` import
 * syntax in ~/.claude/CLAUDE.md.
 *
 * The `@path` import resolves a missing/moved target to nothing with zero
 * warning — a renamed or deleted persona file silently drops that entire
 * block of instructions from every session. This module parses the import
 * chain (recursively, since imported files can themselves import further
 * files) and asserts every resolved target exists and is non-empty, plus
 * reports git ahead/behind for each unique repo the imports live in.
 *
 * Pure functions taking explicit inputs (a root file path), following the
 * evaluateTickLiveness/readFreshHeartbeat pattern in health.cjs so this is
 * independently unit-testable without touching the real home directory.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { lexer } = require('marked');

const MAX_IMPORT_DEPTH = 5;
// The claude CLI's (v2.1.325) @-import token rule: `@` at line start or after
// whitespace, then a run of non-space chars where `\ ` is an escaped space.
const IMPORT_TOKEN_RE = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
const EXPLICIT_PREFIXES = ['./', '../', '~/', '/'];

function resolveImportPath(rawPath, fromFile) {
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2));
  if (rawPath === '~') return os.homedir();
  if (path.isAbsolute(rawPath) || !fromFile) return rawPath;
  return path.resolve(path.dirname(fromFile), rawPath);
}

// Same acceptance test the CLI applies to a token after fragment-cut + unescape.
function isImportToken(tok) {
  if (tok.startsWith('./') || tok.startsWith('~/')) return true;
  if (tok.startsWith('/')) return tok !== '/';
  return !tok.startsWith('@') && !/^[#%^&*()]+/.test(tok) && /^[a-zA-Z0-9._-]/.test(tok);
}

function scanText(text, fromFile, out) {
  IMPORT_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_TOKEN_RE.exec(text)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    let tok = raw;
    const hash = tok.indexOf('#');
    if (hash !== -1) tok = tok.substring(0, hash);
    if (!tok) continue;
    tok = tok.replaceAll('\\ ', ' ');
    if (!tok || !isImportToken(tok)) continue;
    // Whole-line check: the line holding this match is exactly `@<raw>`.
    const atIdx = m.index + m[0].length - raw.length - 1;
    const lineStart = text.lastIndexOf('\n', atIdx) + 1;
    const nl = text.indexOf('\n', atIdx);
    const line = text.slice(lineStart, nl === -1 ? text.length : nl).trim();
    const explicit = EXPLICIT_PREFIXES.some((p) => tok.startsWith(p)) || line === `@${raw}`;
    out.push({ path: resolveImportPath(tok, fromFile), explicit });
  }
}

function walkTokens(tokens, fromFile, out) {
  for (const t of tokens) {
    if (t.type === 'code' || t.type === 'codespan') continue;
    if (t.type === 'html') {
      const raw = t.raw || '';
      const trimmed = raw.trimStart();
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        const rest = raw.replace(/<!--[\s\S]*?-->/g, '');
        if (rest.trim().length > 0) scanText(rest, fromFile, out);
      }
      continue;
    }
    if (t.type === 'text') scanText(t.text || '', fromFile, out);
    if (t.tokens) walkTokens(t.tokens, fromFile, out);
    if (t.items) walkTokens(t.items, fromFile, out);
  }
}

// Extracts every `@<path>` import from a file's raw markdown, using the claude
// CLI's rules (markdown-aware: code blocks/spans skipped). Relative paths
// resolve against fromFile's folder. Returns `{ path, explicit }[]`, deduped by
// path in first-seen order; `explicit` = written with path syntax
// (./ ../ ~/ /) or alone on its line.
function extractImportPaths(content, fromFile) {
  const found = [];
  walkTokens(lexer(content), fromFile, found);
  const byPath = new Map();
  for (const f of found) {
    const prev = byPath.get(f.path);
    if (prev) prev.explicit = prev.explicit || f.explicit;
    else byPath.set(f.path, { ...f });
  }
  return [...byPath.values()];
}

// Recursively walks the import chain starting at rootPath, collecting a
// result per resolved import: { importPath, exists, nonEmpty, ok }.
// Depth-capped to guard against a cyclic-import pathological case. Visited
// paths are deduped so a diamond-shaped import graph doesn't get reported
// twice or blow the depth budget. A non-regular-file target counts as
// missing; an unresolved import is only reported when written explicitly
// (so prose like "ping @bilko" is not flagged).
function walkImports(rootPath, depth = MAX_IMPORT_DEPTH, seen = new Set()) {
  const results = [];
  if (depth <= 0) return results;
  if (!fs.existsSync(rootPath)) return results;

  let content;
  try {
    content = fs.readFileSync(rootPath, 'utf8');
  } catch {
    return results;
  }

  for (const { path: importPath, explicit } of extractImportPaths(content, rootPath)) {
    if (seen.has(importPath)) continue;

    let exists = false;
    let nonEmpty = false;
    try {
      const stat = fs.statSync(importPath);
      exists = stat.isFile();
      nonEmpty = exists && stat.size > 0;
    } catch {
      exists = false;
    }

    if (!exists && !explicit) continue;
    seen.add(importPath);
    results.push({ importPath, exists, nonEmpty, ok: exists && nonEmpty });

    if (exists && nonEmpty) {
      results.push(...walkImports(importPath, depth - 1, seen));
    }
  }

  return results;
}

// Walks upward from startDir looking for a `.git` directory, bounded at
// os.homedir() or the filesystem root.
function findGitRepoRoot(startDir) {
  const home = os.homedir();
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (dir === home) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Reports ahead/behind vs upstream for a git repo, without ever fetching
// (rev-list reports against whatever the local remote-tracking ref already
// has cached). Non-fatal on any failure — no upstream configured, detached
// HEAD, git not installed — annotated as a caveat, never thrown.
function checkRepoAheadBehind(repoRoot) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const [ahead, behind] = out.split(/\s+/).map(Number);
    return { repoRoot, ok: true, ahead, behind };
  } catch (e) {
    return {
      repoRoot,
      ok: false,
      noUpstream: true,
      error: (e.message || String(e)).split('\n')[0],
    };
  }
}

// Top-level entry point: parses ~/.claude/CLAUDE.md's import chain, checks
// every resolved target, and reports ahead/behind for each unique repo those
// imports live in. claudeMdPath is injectable for testing.
function checkPersonaImports(claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md')) {
  if (!fs.existsSync(claudeMdPath)) {
    return { ok: true, path: claudeMdPath, exists: false, imports: [], repos: [] };
  }

  const imports = walkImports(claudeMdPath);
  const broken = imports.filter((i) => !i.ok);

  const repoRoots = new Set();
  for (const imp of imports) {
    if (!imp.ok) continue;
    const repoRoot = findGitRepoRoot(path.dirname(imp.importPath));
    if (repoRoot) repoRoots.add(repoRoot);
  }

  const repos = [...repoRoots].map(checkRepoAheadBehind);

  return {
    ok: broken.length === 0,
    path: claudeMdPath,
    exists: true,
    imports,
    brokenImports: broken,
    repos,
  };
}

module.exports = {
  checkPersonaImports,
  walkImports,
  extractImportPaths,
  resolveImportPath,
  findGitRepoRoot,
  checkRepoAheadBehind,
  MAX_IMPORT_DEPTH,
};
