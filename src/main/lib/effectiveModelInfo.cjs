'use strict';

/**
 * effectiveModelInfo.cjs — read-only observer answering "what will this
 * Epic's agentType actually run as": the persona's model alias, the
 * concrete model id evidence points at, and the provenance of each. Sits
 * BESIDE agentModelResolve.cjs (which decides what a launch actually passes
 * to `--model`) rather than replacing it — nothing here feeds a spawn
 * decision, and agentModelResolve.cjs's own resolution is unchanged.
 *
 * Provenance is the entire point: a caller must be able to tell "we KNOW
 * this alias last ran as claude-opus-5 because a real run resolved it" from
 * "we don't know; the CLI resolves this alias at launch." The two must
 * never collapse into one optimistic string.
 *
 * Effort-level resolution is deliberately NOT here — it already exists,
 * unused, in the renderer's `useEffectiveSettings.ts` (a scope-chain reader
 * with a file watcher). This module supplies only the half that genuinely
 * needs main-process filesystem access: persona lookup (overlay-aware) and
 * concrete-model evidence (scheduler run logs, session transcripts).
 *
 * Never throws — every lookup failure degrades a field to null, same
 * contract as agentModelResolve.cjs's resolveEpicModel.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const { encodeCwd } = require('./encodeCwd.cjs');

// Mirrors rawSessionModel.ts's RAW_MODELS — duplicated rather than imported
// because that file is a renderer ES module and this is a main-process CJS
// module (CLAUDE.md: "No CommonJS in renderer, no ES modules in main").
// Anything NOT in this set is treated as an already-concrete pinned model id
// (e.g. 'claude-opus-5'), never as an alias needing evidence.
const KNOWN_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

// Run-log evidence (scheduler.cjs's executeJob, ~line 4473) is written
// essentially at dispatch time, before any of the run's own stdout streams
// in — so a bounded HEAD read (not a tail) is both correct and cheap even
// against a run log that grows to tens of MB. O(min(size, cap)) time/space.
const MAX_RUN_LOG_HEAD_BYTES = 64 * 1024;

// Same bound epicDelegationStats.cjs's readTranscriptTail uses for a single
// pass over a transcript that can reach tens of MB. O(min(size, cap)).
const MAX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

// Mirrors scheduler.cjs's own ROOT/RUNS_DIR constants (same convention as
// queueStore.cjs's LEGACY_QUEUE_PATH, which duplicates this literal rather
// than requiring scheduler.cjs's ~530KB module graph for one path).
function runsDir(homeDir) {
  return path.join(homeDir, '.claude', 'session-manager', 'scheduled-plans', 'runs');
}

function isConcreteModelId(modelAlias) {
  return Boolean(modelAlias) && !KNOWN_MODEL_ALIASES.has(modelAlias);
}

/**
 * True when this app's spawn path (cleanEnv.cjs's cleanChildEnv) would strip
 * an effort env var before a child ever saw it — i.e. whether the settings
 * schema's env-var effort configuration path is actually reachable for an
 * app-launched session. Derived by probing cleanChildEnv itself rather than
 * hardcoding a boolean, so this self-corrects if that deletion list ever
 * changes instead of silently drifting stale.
 */
function computeEffortReachable(deps) {
  try {
    const { cleanChildEnv } = deps.cleanEnv || require('./cleanEnv.cjs');
    const probe = cleanChildEnv({ CLAUDE_EFFORT: 'high', CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    return Boolean(probe.CLAUDE_EFFORT || probe.CLAUDE_CODE_EFFORT_LEVEL);
  } catch {
    return false;
  }
}

/**
 * Resolves a persona's model alias, overlay-aware (agentLibrary.cjs's
 * getPersonaBody: project overlay at `<cwd>/.claude/agents/<name>.md` wins
 * over the global `~/.claude/agents/<name>.md` — the same precedence
 * `resolvePrdPersonaForSpawn` already uses, unlike `listPersonas`/
 * `readPersonaModel`, which only ever see the global directory).
 *
 * Never throws: a missing/unreadable persona (dangling agentType) resolves
 * to `{ modelAlias: null, modelSource: 'fallback' }` without logging —
 * agentModelResolve.cjs's own `logDanglingPersonaOnce`/`reportDanglingAgentTypeOnce`
 * dedup-per-(cwd,agentType) already covers that diagnostic on the LAUNCH
 * path; this read-only observer deliberately does not add a second logger
 * for the same dangling reference.
 */
async function resolvePersonaModelAlias(cwd, agentType, deps) {
  const getPersonaBody = deps.getPersonaBody || require('../agentLibrary.cjs').getPersonaBody;
  const resolvePersonaPaths = deps.resolvePersonaPaths || require('./epicMint.cjs').resolvePersonaPaths;

  let persona;
  try {
    persona = await getPersonaBody({ cwd, name: agentType });
  } catch {
    persona = null;
  }
  if (!persona) return { modelAlias: null, modelSource: 'fallback' };

  const { fm } = splitFrontmatter(persona.text);

  let fromOverlay = false;
  try {
    const { projectPath } = resolvePersonaPaths(cwd, agentType);
    fromOverlay = Boolean(projectPath) && path.resolve(projectPath) === path.resolve(persona.path);
  } catch {
    // Best-effort overlay signal only — a resolution failure here just means
    // "assume global", never a reason to fail the whole lookup.
  }

  if (fm.model && fm.model !== 'inherit') {
    return { modelAlias: fm.model, modelSource: fromOverlay ? 'persona-overlay' : 'persona' };
  }
  return { modelAlias: null, modelSource: 'inherit' };
}

/** Best-effort read of `<cwd>/session-manager-operations/scheduler/state/queue.json`'s hot jobs[]. */
function readHotJobsForCwd(cwd, deps) {
  const { projectQueuePath } = deps.queueStore || require('./queueStore.cjs');
  try {
    const data = JSON.parse(fs.readFileSync(projectQueuePath(cwd), 'utf8'));
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

/** Best-effort read of `<cwd>/session-manager-operations/scheduler/state/history.jsonl`'s archived rows. */
function readHistoryEntriesForCwd(cwd, deps) {
  const { projectHistoryPath } = deps.queueStore || require('./queueStore.cjs');
  let text;
  try {
    text = fs.readFileSync(projectHistoryPath(cwd), 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      // needs_review_entry/needs_review_resolution lines (needsReviewLedger.cjs)
      // share history.jsonl with terminal job rows but carry no `agentType` —
      // findLatestSchedulerModel's own `j.agentType === agentType` filter
      // already excludes them, but skip explicitly here too so this reader
      // stays correct even if a future ledger line shape happens to pick up
      // an agentType-shaped field.
      if (j?.kind && j.kind !== 'terminal') continue;
      entries.push(j);
    } catch {
      // corrupt/partial line — skip
    }
  }
  return entries;
}

function jobTimestampMs(job) {
  return Date.parse(job?.finishedAt || job?.startedAt || job?.queuedAt || 0) || 0;
}

/** Bounded HEAD read of an absolute file path; null on any read failure. */
function readHead(filePath, maxBytes, deps) {
  const statSync = deps.statSync || fs.statSync;
  const openSync = deps.openSync || fs.openSync;
  const readSync = deps.readSync || fs.readSync;
  const closeSync = deps.closeSync || fs.closeSync;
  try {
    const size = statSync(filePath).size;
    const length = Math.min(maxBytes, size);
    const buffer = Buffer.alloc(length);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, 0);
    } finally {
      closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

/** Bounded TAIL read of an absolute file path; null on any read failure. */
function readTail(filePath, maxBytes, deps) {
  const statSync = deps.statSync || fs.statSync;
  const openSync = deps.openSync || fs.openSync;
  const readSync = deps.readSync || fs.readSync;
  const closeSync = deps.closeSync || fs.closeSync;
  try {
    const size = statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  }
}

/**
 * Evidence source 1: the scheduler already logs the persona-resolved model
 * at dispatch (scheduler.cjs's executeJob, ~line 4473: `[scheduler]
 * agentType=... persona=... model=...`). Scans this project's hot queue.json
 * jobs[] AND its archived history.jsonl for the most recent job whose
 * agentType matches, then reads that job's own run log for the line. O(J log
 * J) to sort J candidate jobs, O(min(logSize, cap)) per log read.
 */
function findLatestSchedulerModel(cwd, agentType, deps) {
  const jobs = [...readHotJobsForCwd(cwd, deps), ...readHistoryEntriesForCwd(cwd, deps)];
  const matches = jobs.filter((j) => j && j.agentType === agentType && j.runId && j.slug);
  matches.sort((a, b) => jobTimestampMs(b) - jobTimestampMs(a));

  const homeDir = deps.homeDir || os.homedir();
  const re = /\[scheduler\] agentType=\S+ persona=.*? model=(\S+)/g;
  for (const job of matches) {
    const logPath = path.join(runsDir(homeDir), job.runId, `${job.slug}.log`);
    const head = readHead(logPath, MAX_RUN_LOG_HEAD_BYTES, deps);
    if (!head) continue;
    let match;
    let last = null;
    while ((match = re.exec(head))) last = match[1];
    if (last) return last;
  }
  return null;
}

/**
 * Evidence source 2: the most recent Epic (active-index.json entry) created
 * with this agentType, read via its own claude-session transcript's last
 * `"model":"..."` occurrence. O(E log E) to sort E candidate Epics,
 * O(min(transcriptSize, cap)) per transcript read.
 */
function findLatestTranscriptModel(cwd, agentType, deps) {
  const readActiveIndex = deps.readActiveIndex || require('./epicMint.cjs').readActiveIndex;
  let sessions;
  try {
    ({ sessions } = readActiveIndex(cwd));
  } catch {
    return null;
  }
  const matches = Object.values(sessions || {}).filter((s) => s && s.agentType === agentType && s.claudeSessionId);
  matches.sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));

  const homeDir = deps.homeDir || os.homedir();
  const encodeCwdFn = deps.encodeCwd || encodeCwd;
  const re = /"model":"([^"]+)"/g;
  for (const session of matches) {
    const filePath = path.join(homeDir, '.claude', 'projects', encodeCwdFn(cwd), `${session.claudeSessionId}.jsonl`);
    const tail = readTail(filePath, MAX_TRANSCRIPT_TAIL_BYTES, deps);
    if (!tail) continue;
    let match;
    let last = null;
    while ((match = re.exec(tail))) last = match[1];
    if (last) return last;
  }
  return null;
}

/**
 * resolveEffectiveModelInfo({ cwd, agentType, deps? }) →
 *   { agentType, modelAlias, modelSource, resolvedModelId, resolvedFrom, effortReachable }
 *
 * Never throws. `cwd` is normalized through the same worktree/ops-internal
 * -aware resolver every ops-root reader goes through, so a job worktree cwd
 * resolves to its main project tree before anything is looked up.
 */
async function resolveEffectiveModelInfo({ cwd, agentType, deps = {} } = {}) {
  const effortReachable = computeEffortReachable(deps);
  const miss = {
    agentType: agentType || null,
    modelAlias: null,
    modelSource: 'fallback',
    resolvedModelId: null,
    resolvedFrom: null,
    effortReachable,
  };
  if (!cwd || !agentType) return miss;

  try {
    const { projectRootOf } = deps.activeSessions || require('./activeSessions.cjs');
    const normalizedCwd = projectRootOf(path.resolve(cwd));
    if (!normalizedCwd) return miss;

    const { modelAlias, modelSource } = await resolvePersonaModelAlias(normalizedCwd, agentType, deps);
    const result = { agentType, modelAlias, modelSource, resolvedModelId: null, resolvedFrom: null, effortReachable };

    if (isConcreteModelId(modelAlias)) {
      // Already a concrete pinned id — echo it back, fabricate no evidence.
      result.resolvedModelId = modelAlias;
      return result;
    }

    // Evidence is never derived via historyAggregator.cjs's resolvePricingKey
    // (which buckets any unknown id to 'sonnet' with estimated:true) —
    // deliberately: that is a pricing heuristic, and borrowing it here would
    // turn "we don't know" into a confident wrong answer.
    const schedulerHit = findLatestSchedulerModel(normalizedCwd, agentType, deps);
    if (schedulerHit) {
      result.resolvedModelId = schedulerHit;
      result.resolvedFrom = 'scheduler-run';
      return result;
    }

    const transcriptHit = findLatestTranscriptModel(normalizedCwd, agentType, deps);
    if (transcriptHit) {
      result.resolvedModelId = transcriptHit;
      result.resolvedFrom = 'transcript';
      return result;
    }

    return result;
  } catch {
    return miss;
  }
}

module.exports = {
  resolveEffectiveModelInfo,
  isConcreteModelId,
  computeEffortReachable,
  KNOWN_MODEL_ALIASES,
};
