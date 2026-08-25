#!/usr/bin/env node
/**
 * audit-ops-hygiene.cjs — one-off (re-runnable) investigation for
 * session-manager-operations/architecture/ops-maintenance-protocol.md
 * Patterns C and D. Read-only: never moves, archives, or deletes anything.
 *
 * Pattern C — legacy flat `scheduler/prds/` layout: reports the current
 * top-level file count vs `scheduler/prds-archived/`, and whether
 * `scheduler/state/queue.json` still references any top-level (non
 * epic-scoped) prdPath, to distinguish "stuck legacy debt" from
 * "legitimately in-flight, already draining via normal completion."
 *
 * Pattern D — orphaned top-level `prompt-sessions/*.json` files (no
 * matching `scheduler/epics/<id>/` dir): for each, inspects its own event
 * chain for `prd_created` events, then — since a dispatched PRD auto-mints
 * its OWN epic dir via epicMint.cjs, with a slug distinct from the
 * originating prompt-session id — searches every PRD `.md` under
 * `scheduler/` for a `sourcePromptId:` frontmatter match before concluding
 * anything is actually lost.
 *
 * Pattern E — PRDs authored outside the sanctioned `scheduler_create_prd` MCP
 * tool (the /develop skill's manual-write fallback is meant to be a rare,
 * flagged last resort — see CLAUDE.md's "PRD authoring is API-only"). Every
 * API-created PRD gets a `prd_create` record in the machine-wide audit log
 * (`~/.claude/session-manager/audit-log.jsonl`, `src/main/lib/auditLog.cjs`)
 * keyed by cwd+slug. This check is deliberately narrow: it only inspects PRD
 * `.md` files `git status` reports as UNTRACKED (never committed yet) — a
 * PRD's file mtime is USELESS as a "recently authored" signal because these
 * files are committed to the target repo, so any `git clone`/`checkout`/
 * `git clean` resets every tracked PRD's mtime to "now" regardless of when it
 * was actually authored (a first draft of this check used mtime and would
 * have false-positived on nearly every already-committed PRD after a fresh
 * checkout). An untracked file, by contrast, really was just created in this
 * working tree. A cwd that isn't a git repo, or has no untracked PRDs, is
 * reported clean — this check simply doesn't apply there. Reported as a
 * hygiene finding, never blocked, exactly like Patterns C/D.
 *
 * Usage: node scripts/audit-ops-hygiene.cjs [cwd]   (defaults to cwd)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectCwd = process.argv[2] || process.cwd();
const OPS_ROOT = path.join(projectCwd, 'session-manager-operations');
const SESSIONS_DIR = path.join(OPS_ROOT, 'prompt-sessions');
const SCHEDULER_DIR = path.join(OPS_ROOT, 'scheduler');
const EPICS_DIR = path.join(SCHEDULER_DIR, 'epics');
const FLAT_PRDS_DIR = path.join(SCHEDULER_DIR, 'prds');
const ARCHIVED_PRDS_DIR = path.join(SCHEDULER_DIR, 'prds-archived');
const QUEUE_PATH = path.join(SCHEDULER_DIR, 'state', 'queue.json');
// Override hook for tests only — production always uses the real path.
const AUDIT_LOG_PATH = process.env.SM_AUDIT_LOG_PATH_OVERRIDE
  || path.join(os.homedir(), '.claude', 'session-manager', 'audit-log.jsonl');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

function auditPatternC() {
  const flatMdFiles = listDir(FLAT_PRDS_DIR).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  const archivedCount = listDir(ARCHIVED_PRDS_DIR).filter((e) => e.isFile() && e.name.endsWith('.md')).length;
  const queue = readJson(QUEUE_PATH, { jobs: [] });
  const jobs = Array.isArray(queue.jobs) ? queue.jobs : [];
  const flatQueueRefs = jobs.filter((j) => typeof j.prdPath === 'string' && j.prdPath.includes(`${path.sep}prds${path.sep}`) && !j.prdPath.includes(`${path.sep}epics${path.sep}`));

  return {
    flatTopLevelMdCount: flatMdFiles.length,
    flatTopLevelMdFiles: flatMdFiles,
    archivedCount,
    queueJobsTotal: jobs.length,
    queueJobsReferencingFlatDir: flatQueueRefs.map((j) => ({ slug: j.slug, status: j.status, prdPath: j.prdPath })),
    verdict: flatMdFiles.length === 0
      ? 'RESOLVED: flat prds/ is currently empty of .md files — consolidation/normal completion has fully drained it.'
      : (flatQueueRefs.length > 0
        ? 'IN-FLIGHT: remaining flat files are referenced by live queue jobs — legitimate in-flight work, not stuck debt.'
        : 'INVESTIGATE: remaining flat files have no live queue reference — check history for stuck/abandoned status before treating as debt.'),
  };
}

const SOURCE_PROMPT_RE = /^sourcePromptId:\s*(.+?)\s*$/m;

function findPrdFilesForEpic(epicId) {
  const hits = [];
  function walk(dir) {
    for (const ent of listDir(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.name.endsWith('.md')) continue;
      let head;
      try { head = fs.readFileSync(full, 'utf8').slice(0, 2000); } catch { continue; }
      const m = SOURCE_PROMPT_RE.exec(head);
      if (m && m[1] === epicId) hits.push(full);
    }
  }
  walk(SCHEDULER_DIR);
  return hits;
}

function auditPatternD() {
  const toplevel = listDir(SESSIONS_DIR)
    .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'active-index.json')
    .map((e) => e.name.slice(0, -'.json'.length))
    .sort();
  const epicDirs = new Set(listDir(EPICS_DIR).filter((e) => e.isDirectory()).map((e) => e.name));

  const neverStarted = [];
  const accountedForElsewhere = [];
  const dataLoss = [];
  const unreadable = [];

  for (const epicId of toplevel) {
    if (epicDirs.has(epicId)) continue; // has a matching epics/ dir — not orphaned

    const data = readJson(path.join(SESSIONS_DIR, `${epicId}.json`), null);
    if (!data) { unreadable.push(epicId); continue; }

    const events = Array.isArray(data.events) ? data.events : [];
    const prdEvents = events.filter((e) => e && e.kind === 'prd_created');
    const session = data.session || {};
    const record = {
      id: epicId,
      status: session.status,
      goalText: (session.goalText || '').slice(0, 80),
      prdCreatedCount: prdEvents.length,
    };

    if (prdEvents.length === 0) { neverStarted.push(record); continue; }

    const found = findPrdFilesForEpic(epicId);
    if (found.length > 0) {
      record.resolvedEpicDirs = [...new Set(found
        .filter((f) => f.startsWith(EPICS_DIR + path.sep))
        .map((f) => path.relative(EPICS_DIR, f).split(path.sep)[0]))];
      accountedForElsewhere.push(record);
    } else {
      dataLoss.push(record);
    }
  }

  return {
    toplevelCount: toplevel.length,
    epicDirsCount: epicDirs.size,
    orphanedCount: toplevel.length - [...epicDirs].filter((d) => toplevel.includes(d)).length,
    neverStarted,
    accountedForElsewhere,
    dataLoss,
    unreadable,
  };
}

/** Every `prd_create` audit event's `${cwd}::${slug}` key. */
function readPrdCreateAuditKeys() {
  const keys = new Set();
  let lines;
  try { lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n'); } catch { return keys; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.kind === 'prd_create' && rec?.cwd && rec?.slug) {
      keys.add(`${rec.cwd}::${rec.slug}`);
    }
  }
  return keys;
}

/**
 * PRD `.md` files `git status --porcelain` reports as untracked (`??`),
 * scoped to `session-manager-operations/scheduler/**\/prds/`. Returns null
 * when `projectCwd` isn't a git repo (or `git` isn't available) — the
 * caller then reports "not applicable" rather than a false CLEAN, since an
 * already-committed bypass wouldn't show up here at all.
 */
function listUntrackedPrdFiles() {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'session-manager-operations/scheduler'], {
      cwd: projectCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const hits = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    const rel = line.slice(3).trim();
    if (!rel.endsWith('.md')) continue;
    if (path.basename(path.dirname(rel)) !== 'prds') continue; // excludes prds-archived/
    hits.push(path.join(projectCwd, rel));
  }
  return hits;
}

function auditPatternE() {
  const untracked = listUntrackedPrdFiles();
  if (untracked === null) {
    return {
      applicable: false,
      checkedCount: 0,
      unattributedCount: 0,
      unattributed: [],
      verdict: 'NOT APPLICABLE: target cwd is not a git repo (or git is unavailable) — cannot distinguish freshly-authored PRDs from committed history.',
    };
  }

  const keys = readPrdCreateAuditKeys();
  const unattributed = [];
  for (const file of untracked) {
    const slug = path.basename(file, '.md');
    const key = `${projectCwd}::${slug}`;
    if (!keys.has(key)) {
      unattributed.push({ file: path.relative(SCHEDULER_DIR, file), slug });
    }
  }

  return {
    applicable: true,
    checkedCount: untracked.length,
    unattributedCount: unattributed.length,
    unattributed,
    verdict: unattributed.length === 0
      ? 'CLEAN: every untracked (not-yet-committed) PRD has a matching prd_create record.'
      : 'INVESTIGATE: untracked PRD(s) with no matching prd_create audit event — likely hand-authored via the /develop manual-write fallback (bypassing scheduler_create_prd). Confirm the bypass was reported and verify the file by hand.',
  };
}

/**
 * Pattern F — referential-integrity report for the Agent/WorkType/Epic/PRD/Job
 * ERD's unvalidated-string foreign keys (`PromptSession.agentType` -> a
 * persona file, `PromptSession.tag` -> the WorkType union, queue-row
 * `epicId`/`sourcePromptId` -> an Epic). "Throw on write, report on read":
 * epicMint.cjs's ensureEpic refuses to MINT a bad reference; this pass only
 * REPORTS references that were valid at creation and later went dangling
 * (persona renamed/deleted, Epic archived) — that is legitimate history, not
 * something this script repairs. Read-only, same as every other pattern here.
 */
function auditPatternF() {
  const { WORK_TYPES } = require('../src/main/lib/workTypeLibrary.cjs');
  const { personaFileExists } = require('../src/main/lib/epicMint.cjs');

  const index = readJson(path.join(SESSIONS_DIR, 'active-index.json'), null);
  const sessions = index && typeof index.sessions === 'object' && index.sessions ? index.sessions : {};

  const danglingAgentType = [];
  const invalidTag = [];
  for (const [epicId, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') continue;
    if (session.agentType && !personaFileExists(projectCwd, session.agentType)) {
      danglingAgentType.push({ epicId, agentType: session.agentType });
    }
    if (session.tag && !WORK_TYPES.includes(session.tag)) {
      invalidTag.push({ epicId, tag: session.tag });
    }
  }

  const queue = readJson(QUEUE_PATH, { jobs: [] });
  const jobs = Array.isArray(queue.jobs) ? queue.jobs : [];
  const danglingJobRefs = [];
  for (const job of jobs) {
    const jobId = job.slug ?? null;
    if (job.epicId && !Object.prototype.hasOwnProperty.call(sessions, job.epicId)) {
      danglingJobRefs.push({ jobId, field: 'epicId', value: job.epicId });
    }
    if (job.sourcePromptId && !Object.prototype.hasOwnProperty.call(sessions, job.sourcePromptId)) {
      danglingJobRefs.push({ jobId, field: 'sourcePromptId', value: job.sourcePromptId });
    }
  }

  const totalFindings = danglingAgentType.length + invalidTag.length + danglingJobRefs.length;

  return {
    danglingAgentTypeCount: danglingAgentType.length,
    danglingAgentType,
    invalidTagCount: invalidTag.length,
    invalidTag,
    danglingJobRefCount: danglingJobRefs.length,
    danglingJobRefs,
    verdict: totalFindings === 0
      ? 'CLEAN: every Epic agentType/tag and queue epicId/sourcePromptId reference resolves.'
      : 'INVESTIGATE: dangling reference(s) found — advisory only, no repair performed (see ops-maintenance-protocol.md).',
  };
}

function main() {
  const c = auditPatternC();
  const d = auditPatternD();
  const e = auditPatternE();
  const f = auditPatternF();

  console.log('=== Pattern C: flat scheduler/prds/ ===');
  console.log(`  top-level .md files: ${c.flatTopLevelMdCount}`);
  console.log(`  prds-archived/ .md files: ${c.archivedCount}`);
  console.log(`  queue jobs referencing flat dir: ${c.queueJobsReferencingFlatDir.length}`);
  console.log(`  verdict: ${c.verdict}`);
  console.log();
  console.log('=== Pattern D: orphaned prompt-sessions/*.json ===');
  console.log(`  top-level files: ${d.toplevelCount}, epics/ dirs: ${d.epicDirsCount}`);
  console.log(`  never-started (safe, no PRD history): ${d.neverStarted.length}`);
  console.log(`  accounted-for-elsewhere (PRD landed under a differently-named epics/ dir): ${d.accountedForElsewhere.length}`);
  console.log(`  DATA LOSS candidates (PRD history, no PRD file found anywhere): ${d.dataLoss.length}`);
  if (d.dataLoss.length > 0) {
    for (const r of d.dataLoss) console.log(`    ESCALATE: ${r.id} (${r.prdCreatedCount} prd_created event(s))`);
  }
  if (d.unreadable.length > 0) console.log(`  unreadable: ${d.unreadable.join(', ')}`);
  console.log();
  console.log('=== Pattern E: hand-authored PRDs (bypassed scheduler_create_prd) ===');
  console.log(`  PRDs checked: ${e.checkedCount}`);
  console.log(`  unattributed (no matching prd_create audit event): ${e.unattributedCount}`);
  if (e.unattributed.length > 0) {
    for (const u of e.unattributed) console.log(`    FLAG: ${u.file}`);
  }
  console.log(`  verdict: ${e.verdict}`);
  console.log();
  console.log('=== Pattern F: referential integrity (agentType / tag / queue epicId+sourcePromptId) ===');
  console.log(`  dangling agentType refs: ${f.danglingAgentTypeCount}`);
  if (f.danglingAgentType.length > 0) {
    for (const r of f.danglingAgentType) console.log(`    FLAG: Epic ${r.epicId} -> agentType '${r.agentType}'`);
  }
  console.log(`  invalid tag values: ${f.invalidTagCount}`);
  if (f.invalidTag.length > 0) {
    for (const r of f.invalidTag) console.log(`    FLAG: Epic ${r.epicId} -> tag '${r.tag}'`);
  }
  console.log(`  dangling queue job refs: ${f.danglingJobRefCount}`);
  if (f.danglingJobRefs.length > 0) {
    for (const r of f.danglingJobRefs) console.log(`    FLAG: job ${r.jobId ?? '(no slug)'} -> ${r.field} '${r.value}'`);
  }
  console.log(`  verdict: ${f.verdict}`);

  return { patternC: c, patternD: d, patternE: e, patternF: f };
}

if (require.main === module) {
  const result = main();
  if (process.env.AUDIT_JSON_OUT) {
    fs.writeFileSync(process.env.AUDIT_JSON_OUT, JSON.stringify(result, null, 2));
  }
}

module.exports = { auditPatternC, auditPatternD, auditPatternE, auditPatternF };
