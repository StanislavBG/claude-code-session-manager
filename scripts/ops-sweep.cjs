#!/usr/bin/env node
/**
 * ops-sweep.cjs — generalized version of
 * session-manager-operations/architecture/ops-maintenance-protocol.md, runnable
 * against ANY project's `session-manager-operations/` folder (Pattern F in that
 * doc). Read-only: never moves, archives, or deletes anything — it only reports.
 *
 * Unlike this project's own audit-ops-hygiene.cjs (which hardcodes
 * session-manager's own OWNERS vocabulary), this script does not assume any
 * particular namespace list. It re-derives the source-of-truth hierarchy for
 * the TARGET project from what's actually on disk there:
 *   1. That project's own CLAUDE.md (if present) — the declared architecture.
 *   2. Each namespace's own README.md under its ops root.
 *   3. On-disk content — folder names, and archived/processed subfolders.
 *
 * It flags, per namespace:
 *   - MISSING_README        — namespace dir has no README.md
 *   - UNDOCUMENTED           — namespace name never mentioned anywhere in the
 *                              project's ownership doc (see below)
 *   - CONTRADICTION          — the ownership doc contains both "retired/gone"
 *                              language AND "owner/owns" language for the same
 *                              namespace, OR the namespace's own README and the
 *                              ownership doc disagree on retired-vs-active status
 *   - NO_RETENTION_POLICY    — namespace has an archived/processed subfolder with
 *                              files but no retention/prune/expire language in its
 *                              README (or no README at all)
 *   - NESTED_CLAUDE_MD_OVER_BUDGET — any CLAUDE.md strictly below the repo root
 *                              (excluding node_modules) exceeds 4000 bytes. Nested
 *                              CLAUDE.md files are scoped-context notes, not the
 *                              root law file, so they get a fixed 4000-byte cap
 *                              rather than the root's self-declared SIZE BUDGET.
 *
 * Ownership-doc resolution (UNDOCUMENTED + the retired/owner-signal checks that
 * feed CONTRADICTION): the single-writer OWNERS enumeration used to live only in
 * the target project's root CLAUDE.md. It can now instead live in a scoped
 * `session-manager-operations/CLAUDE.md`, so these checks read
 * `<targetCwd>/session-manager-operations/CLAUDE.md` when that file exists and
 * fall back to `<targetCwd>/CLAUDE.md` otherwise — so a project that hasn't
 * split its ops docs out yet keeps working unchanged. The root CLAUDE.md's own
 * CLAUDE_MD_OVER_BUDGET check (against its self-declared SIZE BUDGET header) is
 * unaffected by this fallback and always reads the root file.
 *
 * Never deletes/migrates/archives anything and never files Epics itself — it
 * only prints a JSON report. Routing findings into proposed Epics is the
 * calling skill's job (session-manager-dev:ops-sweep), reported to the human
 * pointed at the target project's own cwd.
 *
 * Usage: node scripts/ops-sweep.cjs <target-project-cwd>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseClaudeMdBudget, evaluateClaudeMdBudget, computeEpicIndexDrift } = require('../src/main/health.cjs');

const targetCwd = process.argv[2];
if (!targetCwd) {
  process.stderr.write('usage: ops-sweep.cjs <target-project-cwd>\n');
  process.exit(1);
}

const OPS_ROOT = path.join(targetCwd, 'session-manager-operations');
const CLAUDE_MD_PATH = path.join(targetCwd, 'CLAUDE.md');
const OPS_CLAUDE_MD_PATH = path.join(OPS_ROOT, 'CLAUDE.md');
const NESTED_CLAUDE_MD_BUDGET_BYTES = 4000;

// computeClaudeMdSize(claudeMdText) -> { chars, budget, withinBudget } | null
//
// Reuses health.cjs's parseClaudeMdBudget/evaluateClaudeMdBudget (same
// SIZE BUDGET header convention, same byte-length-not-String.length rule)
// rather than re-implementing the parse here. Returns null when there's no
// CLAUDE.md at all, matching hasClaudeMd's existing null-safe shape.
function computeClaudeMdSize(claudeMdText) {
  if (claudeMdText == null) return null;
  const chars = Buffer.byteLength(claudeMdText, 'utf8');
  const budget = parseClaudeMdBudget(claudeMdText);
  const evaluated = evaluateClaudeMdBudget(chars, budget);
  return { chars, budget, withinBudget: evaluated.ok };
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function listDirEntries(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

function countFilesRecursive(dir, depth = 0) {
  if (depth > 4) return 0;
  let count = 0;
  for (const entry of listDirEntries(dir)) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFilesRecursive(full, depth + 1);
    else count += 1;
  }
  return count;
}

function namespaceMentionRegex(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The two negative lookaheads right after `name` reject a match that's
  // actually a SUBFOLDER reference ("scheduler/prds/") rather than a mention
  // of the namespace itself: `(?![\w-])` rejects a longer identifier
  // ("scheduler2"), `(?!/[\w-])` rejects a continuing path segment
  // ("scheduler/prds"). A bare mention or a trailing-slash-then-boundary
  // mention ("`scheduler`", "scheduler/") still matches. Without this, a
  // namespace's own README describing a retired SUBFOLDER (e.g.
  // "scheduler/prds/ is RETIRED") reads as the whole namespace being
  // retired.
  return new RegExp(`[\`/]?${escaped}(?![\\w-])(?!/[\\w-])/?[\`]?`, 'i');
}

// Extracts just the immediate clause around a mention (up to the nearest
// comma/semicolon/period/parenthesis/em-dash boundary, capped at `radius`
// chars each way) — CLAUDE.md-style docs often list many namespace names in
// one long sentence, so scoping to "same sentence" is still too coarse and
// makes every co-listed namespace look contradictory. Scoping to "same
// clause" keeps a retired/owner signal tied to the namespace it actually
// describes.
const CLAUSE_BOUNDARY_RE = /[,;.()]|—|--/;
function clauseAround(text, matchIndex, matchLen, radius) {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + matchLen + radius);
  let left = text.slice(start, matchIndex);
  let right = text.slice(matchIndex + matchLen, end);
  const leftBoundary = [...left.matchAll(new RegExp(CLAUSE_BOUNDARY_RE, 'g'))].pop();
  if (leftBoundary) left = left.slice(leftBoundary.index + leftBoundary[0].length);
  const rightBoundary = right.match(CLAUSE_BOUNDARY_RE);
  if (rightBoundary) right = right.slice(0, rightBoundary.index);
  return left + text.slice(matchIndex, matchIndex + matchLen) + right;
}

const RETIRED_RE = /\bretir(ed|ement)?\b|\bis gone\b|\bno longer\b|\bfully retired\b/i;
const OWNER_RE = /\bOWNERS?\b|\bowns?\b|\bowning\b|\bsole writer\b/i;
const RETENTION_RE = /\bretention\b|\bprune|\bexpire|\bage out|\bkept for\b|\bkeep(s)? .{0,20}(day|week|month|year)/i;
const ARCHIVE_DIR_RE = /archiv|process/i;

// Scans every namespace-level mention in `text` (per `mentionRe`) and reports
// whether the immediately surrounding clause carries retired/owner language.
// Shared by the ownership-doc scan and the namespace's own README scan so
// both sides of the CONTRADICTION check are scoped identically.
function clauseMentionSignals(text, mentionRe) {
  let retired = false;
  let owner = false;
  if (!text) return { retired, owner };
  const re = new RegExp(mentionRe.source, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    const clause = clauseAround(text, match.index, match[0].length, 120);
    if (RETIRED_RE.test(clause)) retired = true;
    if (OWNER_RE.test(clause)) owner = true;
    if (re.lastIndex === match.index) re.lastIndex++;
  }
  return { retired, owner };
}

if (!fs.existsSync(OPS_ROOT) || !fs.statSync(OPS_ROOT).isDirectory()) {
  process.stdout.write(JSON.stringify({
    targetCwd,
    opsRoot: OPS_ROOT,
    error: 'no session-manager-operations/ folder found at target cwd',
    hasClaudeMd: fs.existsSync(CLAUDE_MD_PATH),
    claudeMdSize: computeClaudeMdSize(readText(CLAUDE_MD_PATH)),
    namespaces: [],
    findings: [],
  }, null, 2) + '\n');
  process.exit(0);
}

const claudeMd = readText(CLAUDE_MD_PATH);
const claudeMdSize = computeClaudeMdSize(claudeMd);
// The OWNERS enumeration may now live in a scoped session-manager-operations/
// CLAUDE.md instead of the root one — see the header comment. Namespace-level
// UNDOCUMENTED/retired/owner-signal checks read that file when it exists.
const ownershipDocPath = fs.existsSync(OPS_CLAUDE_MD_PATH) ? OPS_CLAUDE_MD_PATH : CLAUDE_MD_PATH;
const ownershipDoc = ownershipDocPath === CLAUDE_MD_PATH ? claudeMd : readText(ownershipDocPath);
const namespaceDirs = listDirEntries(OPS_ROOT).filter((e) => e.isDirectory());

const namespaces = [];
const findings = [];

// Epic index drift (orphan_rows/orphan_files/unmirrored) — same three counts
// health.cjs's epic_index component reports, reused here (not
// re-implemented) so the two never disagree. See computeEpicIndexDrift's
// header in src/main/health.cjs.
const epicIndexDrift = computeEpicIndexDrift(targetCwd);
if (epicIndexDrift.orphan_rows > 0) {
  findings.push({
    type: 'EPIC_INDEX_ORPHAN_ROWS',
    detail: `prompt-sessions/active-index.json has ${epicIndexDrift.orphan_rows} row(s) with no matching `
      + `prompt-sessions/<id>.json file (${epicIndexDrift.orphanRowIds.join(', ')})`,
  });
}
if (claudeMdSize && !claudeMdSize.withinBudget) {
  findings.push({
    type: 'CLAUDE_MD_OVER_BUDGET',
    detail: `CLAUDE.md is ${claudeMdSize.chars} chars, over its ${claudeMdSize.budget}-char budget by ${claudeMdSize.chars - claudeMdSize.budget}`,
  });
}

for (const entry of namespaceDirs) {
  const name = entry.name;
  const nsPath = path.join(OPS_ROOT, name);
  const readmePath = path.join(nsPath, 'README.md');
  const readme = readText(readmePath);

  const mentionRe = namespaceMentionRegex(name);
  const mentionedInClaudeMd = ownershipDoc ? mentionRe.test(ownershipDoc) : false;

  // Clause-scoped, not whole-document: a namespace's own README describing a
  // retired SUBFOLDER of itself ("scheduler/prds/ is RETIRED") must not read
  // as the namespace itself being retired. Scoping both sides (ownership doc
  // AND the namespace's own README) to the clause immediately around an
  // actual namespace-level mention (see namespaceMentionRegex) keeps the two
  // signals comparable apples-to-apples.
  const { retired: claudeMdRetiredSignal, owner: claudeMdOwnerSignal } =
    clauseMentionSignals(ownershipDoc, mentionRe);
  const { retired: readmeRetiredSignal } = clauseMentionSignals(readme, mentionRe);

  const archiveSubdirs = listDirEntries(nsPath)
    .filter((e) => e.isDirectory() && ARCHIVE_DIR_RE.test(e.name));
  const archivedFileCount = archiveSubdirs.reduce(
    (sum, d) => sum + countFilesRecursive(path.join(nsPath, d.name)),
    0
  );
  const readmeHasRetentionPolicy = readme ? RETENTION_RE.test(readme) : false;

  const nsFindings = [];

  if (!readme) {
    nsFindings.push({ type: 'MISSING_README', detail: `${name}/ has no README.md` });
  }

  const ownershipDocRelPath = path.relative(targetCwd, ownershipDocPath);

  if (ownershipDoc && !mentionedInClaudeMd) {
    nsFindings.push({
      type: 'UNDOCUMENTED',
      detail: `${name}/ is never mentioned in ${ownershipDocRelPath} — no declared ownership or explicit non-owned status`,
    });
  }

  if (ownershipDoc && claudeMdRetiredSignal && claudeMdOwnerSignal) {
    nsFindings.push({
      type: 'CONTRADICTION',
      detail: `${name}/ has both "retired/gone" language and "owner/owns" language in ${ownershipDocRelPath} — the doc contradicts itself on this namespace's status`,
    });
  }

  if (ownershipDoc && readme && claudeMdRetiredSignal !== readmeRetiredSignal && mentionedInClaudeMd) {
    nsFindings.push({
      type: 'CONTRADICTION',
      detail: `${name}/README.md and ${ownershipDocRelPath} disagree on whether this namespace is retired (README retired=${readmeRetiredSignal}, CLAUDE.md retired=${claudeMdRetiredSignal})`,
    });
  }

  if (archivedFileCount > 0 && !readmeHasRetentionPolicy) {
    nsFindings.push({
      type: 'NO_RETENTION_POLICY',
      detail: `${name}/ has ${archivedFileCount} file(s) under archived/processed subfolder(s) (${archiveSubdirs.map((d) => d.name).join(', ')}) but no stated retention policy in its README`,
    });
  }

  namespaces.push({
    name,
    hasReadme: !!readme,
    mentionedInClaudeMd,
    claudeMdRetiredSignal,
    claudeMdOwnerSignal,
    readmeRetiredSignal,
    archivedFileCount,
    readmeHasRetentionPolicy,
    findings: nsFindings,
  });
  findings.push(...nsFindings.map((f) => ({ namespace: name, ...f })));
}

// Source lint (PRD 1082): every path inside the ops root must be built by
// opsOwnership.cjs's opsPath/resolveOpsRoot — the one place that normalizes
// a worktree or ops-internal cwd and refuses an ephemeral one. Any other file
// under src/main/ spelling the ops-root literal is a regression of that choke
// point and is reported as OPS_PATH_LITERAL. Only meaningful when the target
// IS the session-manager repo (the module has to exist to be bypassed).
const opsPathLint = (() => {
  const resolverPath = path.join(targetCwd, 'src', 'main', 'lib', 'opsOwnership.cjs');
  if (!fs.existsSync(resolverPath)) return { applicable: false, violations: [] };
  const srcMain = path.join(targetCwd, 'src', 'main');
  const violations = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.cjs') || p === resolverPath) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes("'session-manager-operations'") || line.includes('"session-manager-operations"')) {
          violations.push({ file: path.relative(targetCwd, p), line: i + 1, text: line.trim().slice(0, 140) });
        }
      });
    }
  };
  walk(srcMain);
  return { applicable: true, violations };
})();
for (const v of opsPathLint.violations) {
  findings.push({
    type: 'OPS_PATH_LITERAL',
    file: v.file,
    line: v.line,
    detail: `ops-root literal outside lib/opsOwnership.cjs — build the path with opsPath()/resolveOpsRoot() instead: ${v.text}`,
  });
}

// Nested-CLAUDE.md budget lint: every CLAUDE.md strictly below the repo root
// (excluding node_modules and .git) gets a fixed 4000-byte cap — these are
// scoped-context notes (house style: H1 + "What's here"/"Who consumes
// this"/"What must NOT be assumed"), not the root law file, so they don't
// carry a self-declared SIZE BUDGET header the way root CLAUDE.md does.
const NESTED_CLAUDE_MD_EXCLUDE_DIRS = new Set(['node_modules', '.git']);
function findNestedClaudeMdFiles(root) {
  const rootClaudeMdPath = path.join(root, 'CLAUDE.md');
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (NESTED_CLAUDE_MD_EXCLUDE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name === 'CLAUDE.md' && full !== rootClaudeMdPath) found.push(full);
    }
  };
  walk(root);
  return found;
}
const nestedClaudeMdFiles = findNestedClaudeMdFiles(targetCwd);
for (const p of nestedClaudeMdFiles) {
  const bytes = Buffer.byteLength(fs.readFileSync(p, 'utf8'), 'utf8');
  if (bytes > NESTED_CLAUDE_MD_BUDGET_BYTES) {
    findings.push({
      type: 'NESTED_CLAUDE_MD_OVER_BUDGET',
      file: path.relative(targetCwd, p),
      detail: `${path.relative(targetCwd, p)} is ${bytes} bytes, over the ${NESTED_CLAUDE_MD_BUDGET_BYTES}-byte nested-CLAUDE.md cap by ${bytes - NESTED_CLAUDE_MD_BUDGET_BYTES}`,
    });
  }
}

process.stdout.write(JSON.stringify({
  targetCwd,
  opsRoot: OPS_ROOT,
  hasClaudeMd: !!claudeMd,
  claudeMdSize,
  ownershipDocPath: path.relative(targetCwd, ownershipDocPath),
  opsPathLint,
  nestedClaudeMdFiles: nestedClaudeMdFiles.map((p) => path.relative(targetCwd, p)),
  epicIndexDrift: {
    orphan_rows: epicIndexDrift.orphan_rows,
    orphan_files: epicIndexDrift.orphan_files,
    unmirrored: epicIndexDrift.unmirrored,
  },
  namespaceCount: namespaces.length,
  namespaces,
  findings,
}, null, 2) + '\n');
