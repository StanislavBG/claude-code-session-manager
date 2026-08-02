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
 * Usage: node scripts/audit-ops-hygiene.cjs [cwd]   (defaults to cwd)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectCwd = process.argv[2] || process.cwd();
const OPS_ROOT = path.join(projectCwd, 'session-manager-operations');
const SESSIONS_DIR = path.join(OPS_ROOT, 'prompt-sessions');
const SCHEDULER_DIR = path.join(OPS_ROOT, 'scheduler');
const EPICS_DIR = path.join(SCHEDULER_DIR, 'epics');
const FLAT_PRDS_DIR = path.join(SCHEDULER_DIR, 'prds');
const ARCHIVED_PRDS_DIR = path.join(SCHEDULER_DIR, 'prds-archived');
const QUEUE_PATH = path.join(SCHEDULER_DIR, 'state', 'queue.json');

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

function main() {
  const c = auditPatternC();
  const d = auditPatternD();

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

  return { patternC: c, patternD: d };
}

if (require.main === module) {
  const result = main();
  if (process.env.AUDIT_JSON_OUT) {
    fs.writeFileSync(process.env.AUDIT_JSON_OUT, JSON.stringify(result, null, 2));
  }
}

module.exports = { auditPatternC, auditPatternD };
