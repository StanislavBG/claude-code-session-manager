/**
 * queueOps.cjs — bulk PRD operations + queue-health linter.
 *
 * This module is owned by Bundle D. It registers three IPC handlers:
 *
 *   schedule:lint-queue    — scan all PRDs in PRDS_DIR for anti-patterns
 *   schedule:archive-prd   — move PRDS_DIR/<slug>.md → prds-archived/<ISO>/<slug>.md
 *   schedule:retag-prd     — rewrite parallelGroup and/or estimateMinutes
 *                            frontmatter; optionally rename slug to reflect
 *                            the new NN- prefix
 *
 * All file mutations go through tmp + rename for atomicity. Path containment
 * is enforced against PRDS_DIR via path.resolve() + startsWith() (mirrors
 * scheduler.cjs's existing pattern).
 *
 * The linter rules come from research-04 §1 (queue-health) plus PRD 106's
 * regex inventory. Rules:
 *   - `^until ` at the start of a logical line  → fizzpop-style poll hang
 *   - `^while true` (case insensitive)          → unbounded while loop
 *   - `for .* in $(seq 1 [5-9][0-9][0-9]+)`     → unbounded large seq
 *   - missing frontmatter title / cwd (estimateMinutes is optional; if present
 *     it must be a positive integer)
 *   - cwd doesn't exist on disk (fs.accessSync)
 *   - `--no-verify` or `--no-gpg-sign`          → hook-skip flags
 *
 * Severity: 'error' for the loop patterns and missing required frontmatter;
 * 'warn' for the rest.
 *
 * Time complexity: O(F × L) where F = number of PRD files, L = avg line count.
 * Hot-loop-safe: regex tests are pre-compiled module-level constants.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ipcMain } = require('electron');
const { SCHEDULE_SLUG_RE: SLUG_RE, schemas } = require('./ipcSchemas.cjs');
const logs = require('./logs.cjs');
const config = require('./config.cjs');
const { expandHome } = require('./lib/util/expandHome.cjs');
const { HISTORY_RETENTION_MS } = require('./lib/scheduler/schedulerConfig.cjs');
const schedulerPaths = require('./lib/scheduler/schedulerPaths.cjs');
// The one cancelled-row rule (failed OR needs_review + a cancel marker).
const { isCancelledRow } = require('./lib/scheduler/cancelledRow.cjs');

// Lazy: resolved via lib/scheduler/schedulerPaths.cjs at each use (SM_SCHEDULER_HOME).
const prdsArchiveDir = () => path.join(schedulerPaths.scheduledPlansRoot(), 'prds-archived');

// ────────────────────────────────────────────── lint rules

// Each rule: { id, severity, test: (line) => boolean }
// O(1) regex test per line. Module-level so the compiled forms don't churn.
const LINE_RULES = [
  {
    id: 'unbounded-until',
    severity: 'error',
    re: /^\s*until\s+/,
    label: '"until" loop — risk of unbounded poll (see PRD 106 §1)',
  },
  {
    id: 'while-true',
    severity: 'error',
    re: /^\s*while\s+(?:true|:)/i,
    label: '"while true" — unbounded loop',
  },
  {
    id: 'unbounded-seq',
    severity: 'error',
    // for X in $(seq 1 NNN) where NNN ≥ 500. PRD 106 §1 cites this exact pattern.
    re: /for\s+\S+\s+in\s+\$\(seq\s+1\s+[5-9][0-9]{2,}/,
    label: 'unbounded seq — for-loop range ≥500',
  },
  {
    id: 'no-verify',
    severity: 'warn',
    re: /--no-verify\b/,
    label: '--no-verify — skips git hooks',
  },
  {
    id: 'no-gpg-sign',
    severity: 'warn',
    re: /--no-gpg-sign\b/,
    label: '--no-gpg-sign — bypasses signing',
  },
];

// Interactive/GUI-rendering-as-headless-AC patterns (research: PRDs 776/779,
// the 2026-07-30 exit143 incident — a claude -p executor hits a tool-use
// rejection on these and hangs until the scheduler SIGTERMs it, even when
// the step works fine run interactively). Keyed off AC-checkbox context
// specifically (a "- [ ] " line via INTERACTIVE_AC_CHECKBOX_RE), not any
// occurrence anywhere in the file — a PRD's Out-of-scope/Implementation-notes
// prose explicitly telling the executor NOT to do this (e.g. "NOTE: do NOT
// add a `playwright test ... under xvfb` acceptance criterion here", as in
// PRDs 780/787/788) is plain prose, not a checkbox line, so it must not
// trigger a false positive.
const INTERACTIVE_AC_CHECKBOX_RE = /^\s*-\s*\[[ xX]\]/;
const INTERACTIVE_AC_PATTERNS = [
  {
    id: 'interactive-xvfb',
    re: /\bxvfb-run\b/i,
    label: 'xvfb-run as a headless AC — cannot run under claude -p (see PRD_AUTHORING.md / 776+779 incidents)',
  },
  {
    id: 'interactive-electron-launch',
    re: /electron\.launch\b/i,
    label: 'playwright electron.launch as a headless AC — interactive tool-use rejection hangs the executor',
  },
  {
    id: 'interactive-playwright-test',
    re: /\bplaywright\s+test\b/i,
    label: '"playwright test" as a headless AC — GUI-rendering e2e cannot run headlessly',
  },
  {
    id: 'interactive-launch-app',
    re: /\blaunch(?:ing)?\s+the\s+app\b/i,
    label: '"launch the app" as a headless AC — interactive/GUI step',
  },
  {
    id: 'interactive-click-through',
    re: /\bclick(?:ing)?\s+through\b/i,
    label: '"click through" as a headless AC — interactive/GUI step',
  },
  {
    id: 'interactive-screenshot',
    re: /\bscreenshot/i,
    label: 'screenshot capture as a headless AC — interactive/GUI-rendering step',
  },
];

const { splitFrontmatter } = require('./lib/prd/prdFrontmatter.cjs');
const {
  resolvePrdsDirs, resolvePrdWriteDir, listEpicPrdDirs, deriveEpicIdFromPrdPath, deriveProjectCwdFromPrdPath,
  isSafeEpicId,
} = require('./lib/prd/prdLocations.cjs');
const { readJsonOrSync } = require('./lib/util/atomicFs.cjs');
const { opsPath, assertOpsWrite } = require('./lib/opsOwnership.cjs');
const { appendAuditEvent } = require('./lib/telemetry/auditLog.cjs');
const { readActiveIndex } = require('./lib/epic/epicMint.cjs');
const cancelDependents = require('./scheduler/cancelDependents.cjs');

// PRD 808: PRDS_DIR is now the LEGACY global dir — kept as a migration
// source and search fallback for not-yet-migrated files. Live PRDs resolve
// per-project via prdLocations.cjs's resolvePrdsDirs(). candidatePrdsDirs()
// aggregates both so the linter/archive/retag operations still see every
// PRD regardless of which dir it currently lives in.
function candidatePrdsDirs() {
  return [schedulerPaths.prdsRoot(), ...resolvePrdsDirs()];
}

/**
 * Search every candidate PRD dir for `<slug>.md`; returns the containing dir
 * or null. `cwd`, if given, narrows the search to that one project's own PRD
 * dirs (its flat prds/ dir plus its Epic-scoped dirs) instead of scanning
 * every project machine-wide — same narrowing pattern scheduler.cjs's
 * getPrdParsed uses.
 */
async function findPrdDir(slug, cwd) {
  const dirs = cwd ? [resolvePrdWriteDir(cwd), ...listEpicPrdDirs(cwd)] : candidatePrdsDirs();
  for (const dir of dirs) {
    try {
      await fsp.access(path.join(dir, `${slug}.md`));
      return dir;
    } catch { /* not here — try the next candidate dir */ }
  }
  return null;
}

/**
 * Lint a single PRD asynchronously. Returns { slug, findings: [...] }.
 * O(L) per PRD where L is line count of the file. Reads via fsp so kernel
 * I/O can overlap when called via Promise.all from lintAll().
 */
async function lintOneAsync(filePath) {
  const slug = path.basename(filePath, '.md');
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    return {
      slug,
      findings: [{ rule: 'read-error', line: 0, snippet: e?.message ?? 'read failed', severity: 'error' }],
    };
  }
  return lintParsed(slug, raw);
}

function lintParsed(slug, raw) {
  const findings = [];
  const { fm, body, fmLineCount } = splitFrontmatter(raw);

  // Required frontmatter keys.
  if (!fm.title || !fm.title.trim()) {
    findings.push({ rule: 'missing-title', line: 1, snippet: 'frontmatter "title" is required', severity: 'error' });
  }
  if (!fm.cwd || !fm.cwd.trim()) {
    findings.push({ rule: 'missing-cwd', line: 1, snippet: 'frontmatter "cwd" is required', severity: 'error' });
  } else {
    // cwd existence — only if it looks like an absolute path. ~ -> homedir.
    const candidate = expandHome(fm.cwd);
    if (path.isAbsolute(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
      } catch {
        findings.push({
          rule: 'cwd-missing',
          line: 1,
          snippet: `cwd does not exist on disk: ${fm.cwd}`,
          severity: 'error',
        });
      }
    }
  }
  // estimateMinutes is optional (budget.cjs floors a missing one); validate only when present.
  if (fm.estimateMinutes !== undefined && String(fm.estimateMinutes).trim()) {
    const v = Number(fm.estimateMinutes);
    if (!Number.isInteger(v) || v <= 0) {
      findings.push({
        rule: 'bad-estimate',
        line: 1,
        snippet: `"estimateMinutes" must be a positive integer (got: ${fm.estimateMinutes})`,
        severity: 'warn',
      });
    }
  }

  // Body line scan. Line numbers are 1-indexed and reflect the original file
  // (so fm lines are skipped). O(L).
  const bodyLines = body.split('\n');
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (!line) continue;
    for (const rule of LINE_RULES) {
      if (rule.re.test(line)) {
        findings.push({
          rule: rule.id,
          line: fmLineCount + i + 1,
          snippet: `${rule.label} — ${line.trim().slice(0, 80)}`,
          severity: rule.severity,
        });
      }
    }
    // Interactive-AC scan — only on checkbox-format AC lines, see the
    // pattern-list comment above for why prose mentions must not match.
    if (INTERACTIVE_AC_CHECKBOX_RE.test(line)) {
      for (const rule of INTERACTIVE_AC_PATTERNS) {
        if (rule.re.test(line)) {
          findings.push({
            rule: rule.id,
            line: fmLineCount + i + 1,
            snippet: `${rule.label} — ${line.trim().slice(0, 80)}`,
            severity: 'warn',
          });
        }
      }
    }
  }

  return { slug, findings };
}

/**
 * Lint all PRDs in PRDS_DIR. Returns { reports: [...], scannedAt }.
 * O(F × L). F is bounded by the actual prds/ contents (~200 today).
 *
 * Reads are issued in parallel via Promise.all so kernel-side I/O can
 * overlap. Each lintOneAsync is self-isolating (its own try/catch on read),
 * so Promise.all never rejects under normal use.
 */
async function lintAll() {
  const paths = [];
  for (const dir of candidatePrdsDirs()) {
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      paths.push(path.join(dir, name));
    }
  }
  const reports = await Promise.all(paths.map(async (filePath) => {
    try {
      return await lintOneAsync(filePath);
    } catch (e) {
      return {
        slug: path.basename(filePath, '.md'),
        findings: [{ rule: 'lint-error', line: 0, snippet: e?.message ?? 'lint failed', severity: 'error' }],
      };
    }
  }));
  return { reports, scannedAt: Date.now() };
}

// ────────────────────────────────────────────── archive

/**
 * Move <srcDir>/<slug>.md → <srcDir>/../prds-archived/<ISO>/<slug>.md.
 * Atomic rename. Path containment checks both source and destination.
 * Never deletes — always reversible from prds-archived/.
 */
/**
 * The archive directory a PRD found in `srcDir` belongs in: `prds-archived/`
 * SIBLING to its own `prds/`, which for a per-project PRD is
 * `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds-archived/`.
 *
 * PRD sources are per-project and per-Epic (CLAUDE.md's TAB → EPIC → PRD
 * model); the machine-level `~/.claude/session-manager/scheduled-plans/` tree
 * holds only run logs and PRD_AUTHORING.md. Archiving therefore has to follow
 * the source, not a fixed global constant — otherwise a manual archive yanks a
 * PRD out of its Epic and strands it in the retired global tree, splitting one
 * Epic's history across two locations (observed 2026-08-13 with
 * 1035-epic-worktree-ui-surfacing, whose three chain siblings sat in the Epic's
 * own prds-archived/ while it landed under scheduled-plans/). A PRD still in
 * the legacy flat `PRDS_DIR` resolves to `ROOT/prds-archived` here, which is
 * exactly the old behavior — so that case is unchanged.
 */
function archiveDirForSource(srcDir, ts) {
  return path.join(path.dirname(srcDir), 'prds-archived', ts);
}

async function archiveOne(slug, ts, cwd) {
  if (!SLUG_RE.test(slug)) return { ok: false, slug, error: 'invalid slug' };
  const srcDir = await findPrdDir(slug, cwd);
  if (!srcDir) return { ok: false, slug, error: 'not found in any PRDs dir' };
  const src = path.resolve(path.join(srcDir, `${slug}.md`));
  if (!src.startsWith(srcDir + path.sep)) return { ok: false, slug, error: 'path escape (src)' };
  // Destination is derived per-slug (not once for the whole batch): a single
  // archive call can span several projects/Epics, and each PRD has to land
  // beside its own source.
  const archiveDir = archiveDirForSource(srcDir, ts);
  const dst = path.resolve(path.join(archiveDir, `${slug}.md`));
  if (!dst.startsWith(path.resolve(archiveDir) + path.sep)) return { ok: false, slug, error: 'path escape (dst)' };
  try {
    await fsp.mkdir(archiveDir, { recursive: true });
    await fsp.rename(src, dst);
    return { ok: true, slug, archivedTo: dst };
  } catch (e) {
    return { ok: false, slug, error: e?.message ?? 'rename failed' };
  }
}

/**
 * Injected by index.cjs at registration time (see registerQueueOpsHandlers)
 * so a manual archive can retire any still-runnable queue job for the same
 * slug without queueOps.cjs importing scheduler.cjs (circular — scheduler.cjs
 * already requires queueOps.cjs). No-op until set. Only ever invoked when
 * archiveMany is called with { retire: true } (the default, used by the
 * manual schedule:archive-prd path) — autoArchiveCompleted passes
 * { retire: false } because it calls retireCompletedSlugsFn (== scheduler's
 * retireCompletedSlugs) from inside reconcile(), itself always inside a
 * mutate() body; retireCompletedSlugs's own mutate() call would then queue
 * behind the mutate awaiting it and deadlock every tick (2026-09-25 incident).
 */
let retireCompletedSlugsFn = async () => {};

const DISMISS_ROUTE = 'POST /admin/scheduler/dismiss-cancelled';

function cancelledSlugsIn(jobs, cwd) {
  const out = new Set();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!isCancelledRow(j)) continue;
    if (cwd && j.cwd !== cwd) continue;
    out.add(j.slug);
  }
  return out;
}

async function archiveMany(slugs, cwd, { retire = true, jobs } = {}) {
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return { ok: true, archived: 0, archivedTo: null, results: [] };
  }
  // A cancelled row must never be archived: prds-archived/ is read by
  // budget.computeDepHistorySatisfaction as "satisfied", so archiving a
  // cancelled PRD would silently release its dependents. Refuse with a
  // warning pointing at dismiss (prds-cancelled/, never a satisfier).
  let cancelled = new Set();
  if (Array.isArray(jobs)) {
    cancelled = cancelledSlugsIn(jobs, cwd);
  } else if (queueAccess) {
    try { cancelled = cancelledSlugsIn((await queueAccess.readQueue()).jobs, cwd); } catch { /* unreadable queue: no cancel info */ }
  }
  const warnings = [];
  const toArchive = [];
  const refused = [];
  for (const slug of slugs) {
    if (!cancelled.has(slug)) { toArchive.push(slug); continue; }
    const warning = `"${slug}" is a cancelled job — archiving it would make it satisfy dependsOn. `
      + `Dismiss it instead (${DISMISS_ROUTE}); not archived.`;
    warnings.push(warning);
    refused.push({ ok: false, slug, cancelled: true, warning, error: warning });
  }
  if (toArchive.length === 0) {
    return { ok: true, archived: 0, archivedTo: null, results: refused, warnings };
  }
  const inner = await archiveAll(toArchive, cwd, { retire });
  inner.results = [...refused, ...inner.results];
  if (warnings.length > 0) inner.warnings = warnings;
  return inner;
}

async function archiveAll(slugs, cwd, { retire }) {
  // One timestamp for the whole batch (so a multi-slug archive reads as one
  // event), but each slug's destination DIRECTORY is resolved from its own
  // source inside archiveOne — see archiveDirForSource. mkdir moved in there
  // for the same reason: there is no single batch-wide dir to pre-create.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  for (const slug of slugs) {
    results.push(await archiveOne(slug, ts, cwd));
  }
  const archived = results.filter((r) => r.ok).length;
  const archivedSlugs = results.filter((r) => r.ok).map((r) => r.slug);
  if (retire && archivedSlugs.length > 0) {
    await retireCompletedSlugsFn(archivedSlugs).catch((e) => {
      logs.writeLine({ level: 'warn', scope: 'queueOps', message: 'archiveMany: retireCompletedSlugs failed', meta: { error: e?.message } });
    });
  }
  // archivedTo reports where the batch actually landed. With per-source
  // destinations that is only well-defined when every move agreed on one dir
  // (the common single-project case); a genuinely cross-project batch reports
  // null rather than naming one project's dir as if it covered them all.
  const dirs = new Set(results.filter((r) => r.ok).map((r) => path.dirname(r.archivedTo)));
  return { ok: true, archived, archivedTo: dirs.size === 1 ? [...dirs][0] : null, results };
}

// ────────────────────────────────────────────── auto-archive completed PRDs
//
// PRDS_DIR grows monotonically (738+ .md files, ~100% long-completed) because
// nothing ever moves a finished PRD's .md out of the live directory — every
// allocateParallelGroup scan, reconcile listing, and lint pass walks all of
// them. Once a job is durably 'completed' (queueHistory.cjs's same retention
// window has already judged it safe to leave jobs[]) and nothing still needs
// its file in place, move the .md to prds-archived/ alongside it.
//
// 'needs_review' and 'failed' PRDs are NEVER selected here — humans and the
// auto-fix loop (scheduler.cjs's healTargetForFix) still need those files on
// disk. Same fix-plan-protection regex as queueHistory.cjs's partitionJobs,
// duplicated (not shared) because the two modules intentionally stay
// decoupled — kept in sync by comment, same convention queueHistory.cjs uses
// against scheduler.cjs's healTargetForFix.

const FIX_PLAN_RE = /^\d+-fix-/;

function protectedByPendingFix(jobs) {
  const protectedSlugs = new Set();
  for (const j of jobs) {
    if (!j || !FIX_PLAN_RE.test(j.slug || '')) continue;
    if (j.status !== 'pending' && j.status !== 'running') continue;
    protectedSlugs.add(j.slug.replace(/^(\d+)-fix-/, '$1-'));
  }
  return protectedSlugs;
}

/**
 * Pure predicate: which slugs are safe to move to prds-archived/. O(n) over
 * `jobs`. A slug qualifies only when ALL of:
 *   - its job status is 'completed' (never 'needs_review'/'failed'/
 *     'pending'/'running' — the completed check alone also covers "not
 *     itself a pending/running job")
 *   - finishedAt parses and is older than retentionMs (default
 *     HISTORY_RETENTION_MS, the same constant queueHistory.cjs's
 *     partitionJobs uses — by the time a file is archive-eligible its queue
 *     row has already left jobs[] into history.jsonl)
 *   - no pending/running `NN-fix-<slug>` sibling still needs it in place
 */
function selectAutoArchivable(jobs, { nowMs, retentionMs } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const retention = retentionMs ?? HISTORY_RETENTION_MS;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const protectedSlugs = protectedByPendingFix(list);

  const slugs = [];
  for (const j of list) {
    if (!j || !j.slug) continue;
    if (j.status !== 'completed') continue;
    const finishedMs = j.finishedAt ? Date.parse(j.finishedAt) : NaN;
    if (!Number.isFinite(finishedMs)) continue;
    if ((now - finishedMs) <= retention) continue;
    if (protectedSlugs.has(j.slug)) continue;
    slugs.push(j.slug);
  }
  return slugs;
}

/**
 * Selects and moves eligible completed PRDs' .md files to prds-archived/.
 * Reuses archiveMany (no second mover) so moves stay atomic fsp.rename with
 * the same path-containment. No-op (without touching disk) when
 * SM_PRD_AUTOARCHIVE_DISABLE=1. Each successful move is logged one line
 * (slug -> dest).
 *
 * Passes { retire: false } to archiveMany: this runs inside reconcile(),
 * which always runs inside a mutate() body or tickBody, so invoking
 * retireCompletedSlugs (which itself calls mutate()) here would queue that
 * mutate behind the one already awaiting it and deadlock every tick — proven
 * live 2026-09-25. Also unneeded on the merits: selectAutoArchivable only
 * ever selects already-completed jobs, so there is nothing left to retire.
 */
async function autoArchiveCompleted(state, { nowMs } = {}) {
  if (process.env.SM_PRD_AUTOARCHIVE_DISABLE === '1') {
    return { ok: true, archived: 0, archivedTo: null, results: [], skipped: 'disabled' };
  }
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const slugs = selectAutoArchivable(jobs, { nowMs });
  if (slugs.length === 0) {
    return { ok: true, archived: 0, archivedTo: null, results: [] };
  }
  const result = await archiveMany(slugs, undefined, { retire: false, jobs });
  for (const r of result.results) {
    if (r.ok) {
      logs.writeLine({
        level: 'info',
        scope: 'queueOps',
        message: `auto-archived completed PRD: ${r.slug} -> ${r.archivedTo}`,
        meta: { slug: r.slug, dest: r.archivedTo },
      });
    }
  }
  return result;
}

// ────────────────────────────────────────────── dismiss cancelled rows
//
// A cancelled job lands as 'failed' + cancelledAt. Archiving it would file the
// PRD under prds-archived/, which dependency satisfaction counts as "shipped".
// Dismiss is the honest exit: the row leaves the live queue and the PRD moves
// to a prds-cancelled/<ts>/ sibling dir that nothing ever reads as satisfied.

/**
 * Queue access injected by scheduler.cjs at load (queueOps cannot require
 * scheduler.cjs — circular). `mutate` is scheduler's serialized mutate();
 * dismissCancelled calls it from OUTSIDE any mutate body only (2026-09-25
 * deadlock), and autoDismissCancelled never calls it at all.
 */
let queueAccess = null;
function bindQueueAccess(access) {
  queueAccess = access && typeof access.mutate === 'function' && typeof access.readQueue === 'function' ? access : null;
}

const CLOSED_EPIC_STATUSES = new Set(['completed', 'archived']);

/**
 * A completed Epic leaves active-index.json (tombstoned) and lives in
 * prompt-sessions/<id>.json. Returns 'completed' only when that archive reads
 * as closed (non-empty archivedAt + session.status 'completed'); an unsafe id
 * or a missing/corrupt file is not closed.
 */
function archivedEpicStatus(cwd, epicId) {
  if (!isSafeEpicId(epicId)) return null;
  let file;
  try { file = opsPath(cwd, 'prompt-sessions', `${epicId}.json`); } catch { return null; }
  const data = readJsonOrSync(file, null);
  if (!data || typeof data !== 'object') return null;
  const closed = typeof data.archivedAt === 'string' && data.archivedAt !== ''
    && data.session && typeof data.session === 'object' && data.session.status === 'completed';
  return closed ? 'completed' : null;
}

function cancelledDirForSource(srcDir, ts) {
  const parent = path.dirname(srcDir);
  const epicId = deriveEpicIdFromPrdPath(path.join(srcDir, 'x.md'));
  const projectCwd = deriveProjectCwdFromPrdPath(path.join(srcDir, 'x.md'));
  if (projectCwd) {
    try {
      const segs = epicId ? ['scheduler', 'epics', epicId, 'prds-cancelled', ts] : ['scheduler', 'prds-cancelled', ts];
      const dir = opsPath(projectCwd, ...segs);
      if (path.dirname(path.dirname(dir)) === parent) return { dir, owned: true };
    } catch { /* fall through to the plain sibling */ }
  }
  return { dir: path.join(parent, 'prds-cancelled', ts), owned: false };
}

/** Move `<prds>/<slug>.md` → `<prds>/../prds-cancelled/<ts>/<slug>.md`. */
async function moveToCancelled(slug, cwd, ts) {
  const srcDir = await findPrdDir(slug, cwd);
  if (!srcDir) return { ok: true, movedTo: null };
  const src = path.resolve(path.join(srcDir, `${slug}.md`));
  if (!src.startsWith(srcDir + path.sep)) return { ok: false, error: 'path escape (src)' };
  const { dir, owned } = cancelledDirForSource(srcDir, ts);
  const dst = path.resolve(path.join(dir, `${slug}.md`));
  if (!dst.startsWith(path.resolve(dir) + path.sep)) return { ok: false, error: 'path escape (dst)' };
  try {
    if (owned) assertOpsWrite(dst, 'scheduler');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rename(src, dst);
    return { ok: true, movedTo: dst };
  } catch (e) {
    return { ok: false, error: e?.message ?? 'rename failed' };
  }
}

function newTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * dismissCancelled(slug, cwd, { dependents? }) — remove a cancelled row from
 * the live queue and file its PRD under prds-cancelled/. Refuses rows without
 * a cancel marker, and refuses while pending dependents exist unless the same
 * dependents choice cancelJob takes is passed (cancelDependents.cjs).
 */
async function dismissCancelled(slug, cwd, opts = {}) {
  if (!SLUG_RE.test(String(slug ?? ''))) return { ok: false, error: 'invalid slug' };
  if (!queueAccess) return { ok: false, error: 'queue access not bound (scheduler not loaded)' };
  const state = await queueAccess.readQueue();
  if (state?.unreadable) return { ok: false, error: `queue unreadable (${state.unreadable})` };
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const job = jobs.find((j) => j && j.slug === slug && (!cwd || j.cwd === cwd));
  if (!job) {
    return { ok: false, error: `unknown slug "${slug}": no queued job with that name${cwd ? ` in cwd ${cwd}` : ''}` };
  }
  if (!isCancelledRow(job)) {
    return {
      ok: false,
      error: `job "${slug}" is not a cancelled row (status "${job.status}", no cancel marker) — dismiss only applies to cancelled jobs`,
      notCancelled: true,
    };
  }
  const depCwd = job.cwd ?? null;
  const pending = cancelDependents.findPendingDependents(jobs, slug, depCwd);
  let depPlan = null;
  if (pending.length > 0) {
    const names = pending.map((d) => d.slug);
    if (!opts.dependents) {
      return {
        ok: false,
        error: `cancelled job "${slug}" has ${names.length} pending dependent(s): ${names.join(', ')}. `
          + 'Pass dependents: { action: "cascade" } to cancel them too, '
          + '{ action: "repoint", to: "<slug>" } to make them depend on another PRD instead, '
          + 'or { action: "clear" } to drop the dependency.',
        dependents: names,
        choices: [...cancelDependents.DEPENDENTS_ACTIONS],
      };
    }
    depPlan = cancelDependents.planDependentsUpdate(jobs, slug, opts.dependents, depCwd);
    if (!depPlan.ok) return { ok: false, error: depPlan.error, dependents: names };
    if (depPlan.action !== 'cascade' && typeof queueAccess.updatePrd !== 'function') {
      return { ok: false, error: 'updatePrd not bound — cannot rewrite dependents', dependents: names };
    }
    const applied = [];
    for (const edit of depPlan.edits) {
      if (edit.action !== 'setDependsOn') continue;
      const res = await queueAccess.updatePrd({ slug: edit.slug, cwd: depCwd ?? undefined, frontmatter: { dependsOn: edit.dependsOn } });
      if (!res?.ok) {
        for (const done of applied.reverse()) {
          await queueAccess.updatePrd({ slug: done.slug, cwd: depCwd ?? undefined, frontmatter: { dependsOn: done.previous } }).catch(() => null);
        }
        return {
          ok: false,
          error: `could not update dependent ${edit.slug}: ${res?.error ?? 'unknown error'} — "${slug}" was not dismissed`,
          dependents: names,
        };
      }
      applied.push(edit);
    }
  }
  // File first, row second: a row with no file is harmless, but a live PRD
  // file with no row would be re-minted as pending by the next reconcile.
  const move = await moveToCancelled(slug, depCwd ?? undefined, newTs());
  if (!move.ok) return { ok: false, error: `could not move PRD to prds-cancelled/: ${move.error}` };
  const cascadeEdits = depPlan?.action === 'cascade' ? depPlan.edits : [];
  const dependsOnEdits = depPlan && depPlan.action !== 'cascade' ? depPlan.edits : [];
  const cancelledAt = new Date().toISOString();
  let removed = false;
  await queueAccess.mutate((s) => {
    for (const edit of cascadeEdits) {
      const d = s.jobs.find((x) => x.slug === edit.slug && x.cwd === job.cwd);
      if (!d || d.status !== 'pending') continue;
      // Every job status write goes through transitionJob (lint:status-writes); an
      // access binding without its own falls back to the chokepoint module directly.
      const transition = queueAccess.transitionJob || require('./lib/scheduler/scheduleJobTransitions.cjs').transitionJob;
      if (!transition(d, 'failed', { reason: edit.reason, source: 'queueOps:dismissCancelled' })) continue;
      d.error = edit.reason;
      d.cancelledAt = cancelledAt;
      d.finishedAt = cancelledAt;
      d.exitCode = d.exitCode ?? null;
      delete d.runtime;
    }
    for (const edit of dependsOnEdits) {
      const d = s.jobs.find((x) => x.slug === edit.slug && x.cwd === job.cwd);
      if (d) d.dependsOn = edit.dependsOn;
    }
    const idx = s.jobs.findIndex((x) => x.slug === slug && x.cwd === job.cwd && isCancelledRow(x));
    if (idx >= 0) { s.jobs.splice(idx, 1); removed = true; }
  });
  if (typeof queueAccess.broadcast === 'function') {
    await Promise.resolve(queueAccess.broadcast({ flush: true })).catch(() => {});
  }
  const audit = { slug, cwd: depCwd, source: 'manual', movedTo: move.movedTo, removed };
  if (depPlan) Object.assign(audit, { action: depPlan.action, to: depPlan.to ?? null, dependents: depPlan.dependents });
  appendAuditEvent('job_dismiss_cancelled', audit);
  const result = { ok: true, slug, cwd: depCwd, movedTo: move.movedTo, removed };
  if (depPlan) result.dependents = { action: depPlan.action, to: depPlan.to ?? null, slugs: depPlan.dependents };
  return result;
}

/**
 * autoDismissCancelled(state) — reconcile-time pass. Runs INSIDE a mutate
 * body, so it edits `state.jobs` in place and never calls mutate(). Dismisses
 * a cancelled row when its Epic is completed/archived and no pending row in
 * its project (any Epic) still depends on it. Kill switch:
 * SM_CANCELLED_AUTODISMISS_DISABLE=1.
 */
async function autoDismissCancelled(state) {
  if (process.env.SM_CANCELLED_AUTODISMISS_DISABLE === '1') return { dismissed: [], skipped: 'disabled' };
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const candidates = jobs.filter((j) => isCancelledRow(j) && j.epicId && j.cwd);
  if (candidates.length === 0) return { dismissed: [] };
  const indexByCwd = new Map();
  const archiveStatus = new Map();
  // An index entry always wins (a reopened Epic stays open); otherwise the
  // archive file decides, read at most once per (cwd, epicId) per call.
  const epicStatus = (cwd, epicId) => {
    if (!indexByCwd.has(cwd)) indexByCwd.set(cwd, readActiveIndex(cwd).sessions);
    const sessions = indexByCwd.get(cwd);
    if (Object.prototype.hasOwnProperty.call(sessions, epicId)) return sessions[epicId]?.status ?? null;
    const key = `${cwd}\0${epicId}`;
    if (!archiveStatus.has(key)) archiveStatus.set(key, archivedEpicStatus(cwd, epicId));
    return archiveStatus.get(key);
  };
  const ts = newTs();
  const dismissed = [];
  const drop = new Set();
  for (const j of candidates) {
    const status = epicStatus(j.cwd, j.epicId);
    if (!CLOSED_EPIC_STATUSES.has(status)) continue;
    if (cancelDependents.findPendingDependents(jobs, j.slug, j.cwd).length > 0) continue;
    const move = await moveToCancelled(j.slug, j.cwd, ts);
    if (!move.ok) {
      logs.writeLine({ level: 'warn', scope: 'queueOps', message: `auto-dismiss: move failed for ${j.slug}`, meta: { error: move.error } });
      continue;
    }
    drop.add(j);
    dismissed.push(j.slug);
    appendAuditEvent('job_dismiss_cancelled', {
      slug: j.slug, cwd: j.cwd, source: 'auto', epicId: j.epicId, epicStatus: status, movedTo: move.movedTo, removed: true,
    });
  }
  if (drop.size > 0) state.jobs = jobs.filter((j) => !drop.has(j));
  return { dismissed };
}

// ────────────────────────────────────────────── retag

/**
 * Re-serialize the frontmatter of one PRD, optionally rewriting parallelGroup
 * and/or estimateMinutes. If parallelGroup changes AND the slug has an NN-
 * prefix, the file is renamed to reflect the new prefix (the old NN is
 * stripped and replaced; if no prefix exists, one is prepended).
 *
 * Returns { ok, slug, newSlug, before, after, error? }.
 *
 * Mutates only the keys explicitly passed — preserves all other frontmatter
 * lines verbatim (line-level replace, not a full YAML reparse). Reversible
 * via retag-log.jsonl.
 */
async function retagOne({ slug, parallelGroup, estimateMinutes }) {
  if (!SLUG_RE.test(slug)) return { ok: false, slug, error: 'invalid slug' };
  const dir = await findPrdDir(slug);
  if (!dir) return { ok: false, slug, error: 'not found in any PRDs dir' };
  const src = path.resolve(path.join(dir, `${slug}.md`));
  if (!src.startsWith(dir + path.sep)) return { ok: false, slug, error: 'path escape' };

  let raw;
  try {
    raw = await fsp.readFile(src, 'utf8');
  } catch (e) {
    return { ok: false, slug, error: `read failed: ${e?.message}` };
  }
  if (!raw.startsWith('---\n')) {
    return { ok: false, slug, error: 'no frontmatter to retag' };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { ok: false, slug, error: 'unterminated frontmatter' };

  const fmRaw = raw.slice(4, end);
  const bodyTail = raw.slice(end); // includes "\n---..."
  const fmLines = fmRaw.split('\n');

  // Snapshot before-values for the retag log.
  const before = {};
  const newFmLines = [];
  const seen = { parallelGroup: false, estimateMinutes: false };
  for (const line of fmLines) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
    if (!m) {
      newFmLines.push(line);
      continue;
    }
    const key = m[1];
    if (key === 'parallelGroup' && parallelGroup !== undefined) {
      before.parallelGroup = m[2];
      newFmLines.push(`parallelGroup: ${parallelGroup}`);
      seen.parallelGroup = true;
    } else if (key === 'estimateMinutes' && estimateMinutes !== undefined) {
      before.estimateMinutes = m[2];
      newFmLines.push(`estimateMinutes: ${estimateMinutes}`);
      seen.estimateMinutes = true;
    } else {
      newFmLines.push(line);
    }
  }
  if (parallelGroup !== undefined && !seen.parallelGroup) {
    newFmLines.push(`parallelGroup: ${parallelGroup}`);
  }
  if (estimateMinutes !== undefined && !seen.estimateMinutes) {
    newFmLines.push(`estimateMinutes: ${estimateMinutes}`);
  }

  const newRaw = `---\n${newFmLines.join('\n')}${bodyTail}`;

  // Decide whether to rename the file. NN-kebab pattern only.
  let newSlug = slug;
  if (parallelGroup !== undefined) {
    const m = slug.match(/^(\d+)-(.+)$/);
    if (m) {
      newSlug = `${parallelGroup}-${m[2]}`;
    } else {
      // Slug doesn't have NN- prefix — prepend one.
      newSlug = `${parallelGroup}-${slug}`;
    }
    if (!SLUG_RE.test(newSlug)) return { ok: false, slug, error: 'new slug would be invalid' };
  }
  const dst = path.resolve(path.join(dir, `${newSlug}.md`));
  if (!dst.startsWith(dir + path.sep)) return { ok: false, slug, error: 'new path escape' };

  // Atomic write via shared helper. If slug changed, write at the new path
  // and unlink the old slug.
  try {
    await config.writeTextAtomic(dst, newRaw, { writer: 'scheduler' });
    if (dst !== src) {
      try { await fsp.unlink(src); } catch { /* if src is already same as dst (race), fine */ }
    }
  } catch (e) {
    return { ok: false, slug, error: `write failed: ${e?.message}` };
  }

  const after = {};
  if (parallelGroup !== undefined) after.parallelGroup = String(parallelGroup);
  if (estimateMinutes !== undefined) after.estimateMinutes = String(estimateMinutes);
  if (newSlug !== slug) {
    before.slug = slug;
    after.slug = newSlug;
  }
  return { ok: true, slug, newSlug, before, after };
}

async function appendRetagLog(entries) {
  if (entries.length === 0) return;
  try {
    await fsp.mkdir(schedulerPaths.scheduledPlansRoot(), { recursive: true });
    const lines = entries.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n').join('');
    await fsp.appendFile(path.join(schedulerPaths.scheduledPlansRoot(), 'retag-log.jsonl'), lines);
  } catch (e) {
    logs.writeLine({ level: 'warn', scope: 'queueOps', message: 'retag log append failed', meta: { error: e?.message } });
  }
}

async function retagMany(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, retagged: 0, results: [] };
  }
  const results = [];
  for (const item of items) {
    results.push(await retagOne(item));
  }
  await appendRetagLog(results.filter((r) => r.ok));
  const retagged = results.filter((r) => r.ok).length;
  return { ok: true, retagged, results };
}

// ────────────────────────────────────────────── IPC registration

function registerQueueOpsHandlers({ retireCompletedSlugs } = {}) {
  if (typeof retireCompletedSlugs === 'function') {
    retireCompletedSlugsFn = retireCompletedSlugs;
  }
  ipcMain.handle('schedule:lint-queue', async () => {
    return lintAll();
  });

  ipcMain.handle('schedule:archive-prd', async (_e, payload) => {
    let parsed;
    try { parsed = schemas.scheduleArchivePrd.parse(payload); }
    catch (e) { return { ok: false, error: e?.message ?? 'invalid payload' }; }
    return archiveMany(parsed.slugs);
  });

  ipcMain.handle('schedule:retag-prd', async (_e, payload) => {
    let parsed;
    try { parsed = schemas.scheduleRetagPrd.parse(payload); }
    catch (e) { return { ok: false, error: e?.message ?? 'invalid payload' }; }
    return retagMany(parsed.items);
  });
}

module.exports = {
  registerQueueOpsHandlers,
  // Exposed for tests / future direct calls.
  lintAll,
  lintOneAsync,
  archiveMany,
  bindQueueAccess,
  dismissCancelled,
  autoDismissCancelled,
  selectAutoArchivable,
  autoArchiveCompleted,
  retagMany,
  archiveDirForSource,
  candidatePrdsDirs,
  findPrdDir,
};

// Lazy path getters (SM_SCHEDULER_HOME resolved at read, never at require).
Object.defineProperty(module.exports, 'PRDS_DIR', { get: schedulerPaths.prdsRoot, enumerable: true });
Object.defineProperty(module.exports, 'PRDS_ARCHIVE_DIR', { get: prdsArchiveDir, enumerable: true });
