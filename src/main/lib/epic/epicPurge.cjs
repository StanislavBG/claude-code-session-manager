'use strict';

/**
 * epicPurge.cjs — the ONE way an Epic's data leaves this machine: a human-only
 * purge. Keep-forever stays the default retention for every namespace; this is
 * the single, explicit exception (session-manager-operations/AGENTS.md).
 *
 * purgeEpic({ cwd, epicId, authority }) removes, in order:
 *   1. CLI JSONL (~/.claude/projects/<enc>/<sid>.jsonl + its <sid>/ subagent dir,
 *      every candidate epicTranscriptPath.cjs knows) and a non-Claude agent-CLI
 *      transcript (agentCliSessionStore.transcriptPathFor).
 *   2. Run logs: every `<slug>.*` file of the Epic's slugs in the scheduler runs dir
 *      (runLogRetention.cjs's scanRunEntries).
 *   3. History rows: the Epic's rows in the project history shard and the legacy
 *      global history file (queueHistory.cjs).                    writer 'scheduler'
 *   4. PRD sources + outcome records: scheduler/epics/<epicId>/ (prdOutcomeRecord.cjs
 *      layout), and plan-records/<epicId>/.                       writer 'scheduler'
 *   5. Event log: events/<epicId>/ (epicEventLog.cjs).           writer 'event-log'
 *   6. Agent-snapshot refs: the Epic's pinned agents/snapshots/<id>.json when no
 *      other Epic or queue row still references it (agentSnapshot.cjs). writer 'agents'
 *   7. Archived transcript prompt-sessions/transcripts-archive/<epicId>.jsonl.gz,
 *      the Epic JSON prompt-sessions/<epicId>.json (and any archive JSON whose
 *      session.id is this Epic), and the active-index row + events, leaving only a
 *      content-free tombstone (an ISO time) so a stale renderer cannot resurrect it.
 *                                                                  writer 'epics'
 * then appends ONE audit record { kind: 'epic_purged', epicId, at } (auditLog.cjs,
 * which also stamps its usual pid/ppid caller context) — never a title, prompt or
 * any content.
 *
 * Every ops-root delete goes through assertOpsWrite with the namespace's owning
 * writer (single-writer law, opsOwnership.cjs). Refusals return
 * { ok: false, code, error } and touch nothing:
 *   - not_human: `authority` is not PURGE_AUTHORITY_IPC (the purge IPC handler,
 *     the only caller a human press reaches).
 *   - invalid_epic_id: unsafe id.
 *   - epic_running: a queue row of this Epic is `running`.
 *
 * purgeEpic({ cwd, epicId, dryRun: true }) walks the same seven steps and
 * returns every artifact it WOULD remove — { ok, dryRun: true, artifacts:
 * [{ kind, path }], counts: { <kind>: n }, total, removed: [] } — deleting and
 * writing nothing (no tombstone, no audit record). A dry run needs no
 * `authority` (scripts/purge-dry-run.cjs calls it read-only); a real purge still
 * refuses anything but PURGE_AUTHORITY_IPC. A real purge returns the same
 * artifacts/counts/total for what it actually removed. Artifact kinds:
 * PURGE_ARTIFACT_KINDS.
 *
 * Not removed: queue.json rows (the live scheduler owns that file in memory —
 * a terminal row ages into history on the next reconcile; a pending row whose
 * PRD source is gone is skipped), and earlier audit-log records (a security trace).
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertOpsWrite, opsPath, parseOpsPath } = require('../opsOwnership.cjs');
const atomicFs = require('../util/atomicFs.cjs');

/** The purge IPC handler's authority token — the only accepted `authority`. */
const PURGE_AUTHORITY_IPC = 'ipc:promptSessions:purge-epic';

/** Every artifact kind a purge can remove, in purge order. */
const PURGE_ARTIFACT_KINDS = Object.freeze([
  'cli-transcript', 'run-log', 'history-rows', 'prd-sources', 'plan-records',
  'event-log', 'agent-snapshot', 'archived-transcript', 'epic-json', 'index-row',
]);

const EPIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function refuse(code, error) {
  return { ok: false, code, error };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/**
 * The purge's running ledger. `dryRun` true = record only, never touch disk.
 * @param {boolean} dryRun
 */
function makeLedger(dryRun) {
  /** @type {{ kind: string, path: string }[]} */
  const artifacts = [];
  return {
    dryRun,
    artifacts,
    add(kind, p) { artifacts.push({ kind, path: p }); },
  };
}

/**
 * Remove `p` (file or dir, recursive) and record it as `kind`. Inside an ops root
 * the owning writer is asserted first. A dry-run ledger only records. Returns true
 * when something was (or would be) removed.
 */
function removeOwned(p, writer, kind, ledger) {
  if (!exists(p)) return false;
  if (parseOpsPath(p).inOps) assertOpsWrite(p, writer);
  if (!ledger.dryRun) fs.rmSync(p, { recursive: true, force: true });
  ledger.add(kind, p);
  return true;
}

/** The project queue shard's jobs (raw rows; [] when absent/unreadable). */
function readProjectJobs(cwd) {
  try {
    const { projectQueuePath } = require('../scheduler/queueStore.cjs');
    const data = readJson(projectQueuePath(cwd));
    return data && Array.isArray(data.jobs) ? data.jobs.filter((j) => j && typeof j === 'object') : [];
  } catch {
    return [];
  }
}

function rowIsEpic(row, epicId) {
  return !!row && typeof row === 'object' && (row.epicId === epicId || row.sourcePromptId === epicId);
}

/** History files in play for this project: its shard + the legacy global file. */
function historyFiles(cwd) {
  const out = [];
  try { out.push(require('../scheduler/queueStore.cjs').projectHistoryPath(cwd)); } catch { /* unusable cwd */ }
  try { out.push(require('../scheduler/queueHistory.cjs').historyPath()); } catch { /* no scheduler home */ }
  return [...new Set(out)];
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }
}

/** Slugs this Epic ran: queue rows, history rows, and its PRD sources. */
function collectSlugs(cwd, epicId, jobs) {
  const slugs = new Set();
  for (const j of jobs) if (rowIsEpic(j, epicId) && typeof j.slug === 'string') slugs.add(j.slug);
  for (const file of historyFiles(cwd)) {
    for (const line of readLines(file) || []) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (rowIsEpic(row, epicId) && typeof row.slug === 'string') slugs.add(row.slug);
    }
  }
  try {
    for (const name of fs.readdirSync(opsPath(cwd, 'scheduler', 'epics', epicId, 'prds'))) {
      if (name.endsWith('.md')) slugs.add(name.slice(0, -3));
    }
  } catch { /* no PRD dir */ }
  return slugs;
}

/** Rewrite each history file without the Epic's rows (rows of its slugs count too). */
function purgeHistoryRows(cwd, epicId, slugs, ledger) {
  for (const file of historyFiles(cwd)) {
    const lines = readLines(file);
    if (!lines) continue;
    const keep = [];
    let dropped = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let row = null;
      try { row = JSON.parse(line); } catch { /* keep a torn line untouched */ }
      if (row && (rowIsEpic(row, epicId) || (typeof row.slug === 'string' && slugs.has(row.slug) && !row.epicId))) {
        dropped += 1;
        continue;
      }
      keep.push(line);
    }
    if (!dropped) continue;
    if (parseOpsPath(file).inOps) assertOpsWrite(file, 'scheduler');
    if (!ledger.dryRun) atomicFs.writeTextAtomicSync(file, keep.length ? `${keep.join('\n')}\n` : '');
    ledger.add('history-rows', file);
  }
}

/** Every run-log file of the Epic's slugs. */
function purgeRunLogs(slugs, ledger) {
  if (!slugs.size) return;
  let runsDir;
  try { runsDir = require('../scheduler/schedulerPaths.cjs').runsDir(); } catch { return; }
  const { scanRunEntries } = require('../scheduler/runLogRetention.cjs');
  for (const entry of scanRunEntries(runsDir)) {
    if (!slugs.has(entry.slug)) continue;
    for (const f of entry.files) removeOwned(f, 'scheduler', 'run-log', ledger);
    if (ledger.dryRun) continue;
    try { if (fs.readdirSync(entry.dir).length === 0) fs.rmdirSync(entry.dir); } catch { /* not empty / gone */ }
  }
}

/** CLI JSONL (+ <sid>/ subagent dir) at every candidate location, and a non-Claude transcript. */
function purgeCliTranscripts(cwd, sid, ledger) {
  const { resolveEpicTranscriptPath } = require('./epicTranscriptPath.cjs');
  const { candidates } = resolveEpicTranscriptPath({ cwd, claudeSessionId: sid });
  for (const file of candidates) {
    removeOwned(file, null, 'cli-transcript', ledger);
    const sideDir = file.replace(/\.jsonl$/, '');
    if (sideDir !== file) removeOwned(sideDir, null, 'cli-transcript', ledger);
  }
  try {
    const file = require('../agent-cli/agentCliSessionStore.cjs').transcriptPathFor(sid);
    removeOwned(file, null, 'cli-transcript', ledger);
  } catch { /* no agent-cli store / invalid id */ }
}

/** Snapshot ids still referenced by any OTHER Epic (index rows, archive JSONs) or queue row. */
function snapshotRefsElsewhere(cwd, epicId, sessions, jobs) {
  const refs = new Set();
  for (const [id, s] of Object.entries(sessions)) {
    if (id !== epicId && s && typeof s.agentSnapshotId === 'string') refs.add(s.agentSnapshotId);
  }
  for (const j of jobs) {
    if (!rowIsEpic(j, epicId) && typeof j.agentSnapshotId === 'string') refs.add(j.agentSnapshotId);
  }
  for (const { session } of archiveJsons(cwd)) {
    if (session && session.id !== epicId && typeof session.agentSnapshotId === 'string') refs.add(session.agentSnapshotId);
  }
  return refs;
}

/** prompt-sessions/*.json (minus active-index.json), parsed; `session` unwrapped. */
function archiveJsons(cwd) {
  const dir = opsPath(cwd, 'prompt-sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'active-index.json') continue;
    const file = path.join(dir, name);
    const parsed = readJson(file);
    const session = parsed && typeof parsed === 'object'
      ? (parsed.session && typeof parsed.session === 'object' ? parsed.session : parsed)
      : null;
    out.push({ file, name, session });
  }
  return out;
}

/** Drop the index row + events, record a content-free tombstone (writer 'epics'). */
async function purgeIndexRow(cwd, epicId, ledger) {
  const { activeIndexPath, readActiveIndex, withPathLock } = require('./epicMint.cjs');
  const file = activeIndexPath(cwd);
  if (ledger.dryRun) {
    // Read-only: no lock, no tombstone — list the file only when it holds this Epic.
    const index = readActiveIndex(cwd);
    if (exists(file) && (Object.prototype.hasOwnProperty.call(index.sessions, epicId)
      || Object.prototype.hasOwnProperty.call(index.events, epicId))) {
      ledger.add('index-row', file);
    }
    return;
  }
  await withPathLock(file, () => {
    if (!exists(file)) return;
    const index = readActiveIndex(cwd);
    delete index.sessions[epicId];
    delete index.events[epicId];
    index.tombstones[epicId] = new Date().toISOString();
    assertOpsWrite(file, 'epics');
    atomicFs.writeJsonAtomicSync(file, index, { newline: false });
    ledger.add('index-row', file);
  });
}

/** { artifacts, counts, total } from a ledger; counts has every kind (0 when none). */
function summarize(ledger) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const k of PURGE_ARTIFACT_KINDS) counts[k] = 0;
  for (const a of ledger.artifacts) counts[a.kind] = (counts[a.kind] || 0) + 1;
  return { artifacts: ledger.artifacts, counts, total: ledger.artifacts.length };
}

/**
 * purgeEpic({ cwd, epicId, authority, dryRun }) →
 *   Promise<{ ok: true, dryRun, artifacts, counts, total, removed: string[] } | { ok: false, code, error }>.
 */
async function purgeEpic({ cwd, epicId, authority, dryRun = false } = /** @type {any} */ ({})) {
  const isDryRun = dryRun === true;
  if (!isDryRun && authority !== PURGE_AUTHORITY_IPC) {
    return refuse('not_human', 'epicPurge: only the purge IPC handler (a human press) may purge an Epic');
  }
  if (typeof epicId !== 'string' || !EPIC_ID_RE.test(epicId)) {
    return refuse('invalid_epic_id', `epicPurge: invalid epicId "${epicId}"`);
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return refuse('invalid_cwd', 'epicPurge: cwd must be an absolute path');
  }

  const jobs = readProjectJobs(cwd);
  if (jobs.some((j) => rowIsEpic(j, epicId) && j.status === 'running')) {
    return refuse('epic_running', `epicPurge: Epic ${epicId} has a running job — stop it first`);
  }

  const { readActiveIndex } = require('./epicMint.cjs');
  const sessions = readActiveIndex(cwd).sessions;
  const ownArchives = archiveJsons(cwd).filter(({ name, session }) => name === `${epicId}.json` || (session && session.id === epicId));
  const row = (Object.prototype.hasOwnProperty.call(sessions, epicId) && sessions[epicId])
    || (ownArchives.find((a) => a.session) || {}).session
    || {};
  const sid = typeof row.claudeSessionId === 'string' && row.claudeSessionId ? row.claudeSessionId : epicId;
  const snapshotId = typeof row.agentSnapshotId === 'string' ? row.agentSnapshotId : null;

  const ledger = makeLedger(isDryRun);

  // 1. CLI transcripts — before the index row goes, since the candidate list reads it.
  purgeCliTranscripts(cwd, sid, ledger);

  // 2-3. Run logs + history rows (scheduler).
  const slugs = collectSlugs(cwd, epicId, jobs);
  purgeRunLogs(slugs, ledger);
  purgeHistoryRows(cwd, epicId, slugs, ledger);

  // 4. PRD sources + outcome records, plan records (scheduler).
  removeOwned(opsPath(cwd, 'scheduler', 'epics', epicId), 'scheduler', 'prd-sources', ledger);
  removeOwned(opsPath(cwd, 'plan-records', epicId), 'scheduler', 'plan-records', ledger);

  // 5. Event log (event-log).
  removeOwned(opsPath(cwd, 'events', epicId), 'event-log', 'event-log', ledger);

  // 6. Agent snapshot, only when nothing else still pins it (agents).
  if (snapshotId && /^[0-9a-f]{64}$/.test(snapshotId)
    && !snapshotRefsElsewhere(cwd, epicId, sessions, jobs).has(snapshotId)) {
    const snapFile = opsPath(cwd, 'agents', 'snapshots', `${snapshotId}.json`);
    removeOwned(snapFile, 'agents', 'agent-snapshot', ledger);
  }

  // 7. Archived transcript, Epic JSON(s), index row (epics).
  const { sidecarPath } = require('./archivedTranscript.cjs');
  const sidecar = sidecarPath(cwd, epicId);
  removeOwned(sidecar, 'epics', 'archived-transcript', ledger);
  for (const { file } of ownArchives) removeOwned(file, 'epics', 'epic-json', ledger);
  await purgeIndexRow(cwd, epicId, ledger);

  const summary = summarize(ledger);
  if (isDryRun) return { ok: true, dryRun: true, ...summary, removed: [] };

  require('../telemetry/auditLog.cjs').appendAuditEvent('epic_purged', { epicId });
  return { ok: true, dryRun: false, ...summary, removed: summary.artifacts.map((a) => a.path) };
}

module.exports = { purgeEpic, PURGE_AUTHORITY_IPC, PURGE_ARTIFACT_KINDS };
