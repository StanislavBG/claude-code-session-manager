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

const MAX_IMPORT_DEPTH = 5;
// Matches a line consisting of `@` followed by an absolute or ~-relative path,
// e.g. "@/home/user/foo.md" or "@~/Projects/Agents/shared/core.md".
const IMPORT_LINE_RE = /^@(~?\/\S+)\s*$/;

function resolveImportPath(rawPath) {
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2));
  if (rawPath === '~') return os.homedir();
  return rawPath;
}

// Extracts every `@<path>` import reference from a file's raw text content.
function extractImportPaths(content) {
  const paths = [];
  for (const line of content.split('\n')) {
    const match = IMPORT_LINE_RE.exec(line.trim());
    if (match) paths.push(resolveImportPath(match[1]));
  }
  return paths;
}

// Recursively walks the import chain starting at rootPath, collecting a
// result per resolved import: { importPath, exists, nonEmpty, ok }.
// Depth-capped to guard against a cyclic-import pathological case. Visited
// paths are deduped so a diamond-shaped import graph doesn't get reported
// twice or blow the depth budget.
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

  for (const importPath of extractImportPaths(content)) {
    if (seen.has(importPath)) continue;
    seen.add(importPath);

    let exists = false;
    let nonEmpty = false;
    try {
      const stat = fs.statSync(importPath);
      exists = true;
      nonEmpty = stat.size > 0;
    } catch {
      exists = false;
    }

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
