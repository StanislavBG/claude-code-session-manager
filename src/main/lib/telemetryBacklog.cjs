'use strict';

/**
 * telemetryBacklog.cjs — drains the PRE-EXISTING backlog of structured error
 * logs (`<project>/session-manager-operations/logs/errors-<date>.jsonl`,
 * written by opsErrorLog.cjs) into telemetryClient, and marks exactly what
 * was CONFIRMED delivered so nothing is ever sent twice and nothing is
 * silently lost.
 *
 * This is the "existing errors sent and marked done" half of the product
 * instruction telemetryBoot.cjs documents ("on installation of a new version
 * and loadup, existing errors are sent and marked done; new errors are
 * accumulated and periodically sent (daily)"). telemetryBoot/telemetryClient
 * own the daily-accumulate half; this module owns the backlog half. It does
 * NOT send anything itself — telemetryClient.reportError/logLine/flush are
 * the sole sender + the sole idempotency authority (recordId dedup,
 * telemetry-sent.json). This module is a SECOND, independent bookkeeper over
 * the same records (a byte-offset watermark), because a single writer can't
 * safely satisfy both "resume where we left off" (needs an optimistic,
 * fast-advancing offset) and "never lose a record to queue eviction" (needs
 * a conservative, delivery-confirmed offset) at once — see the two-phase
 * design below.
 *
 * TWO-PHASE WATERMARK. Per file, ~/.config/session-manager/telemetry-
 * watermarks.json tracks:
 *   - bytesEnqueued:  how far we've read + handed lines to telemetryClient.
 *                     Advances the instant a line has been processed
 *                     (whether telemetryClient's queue accepted it, rejected
 *                     it as a duplicate, or dropped it via its own
 *                     dedup window) — malformed/duplicate/deduped lines must
 *                     never be able to wedge a file's forward progress, the
 *                     same principle opsErrorLog-adjacent lines document for
 *                     malformed JSON.
 *   - bytesConfirmed: only advances for the CONTIGUOUS prefix of lines whose
 *                     recordId telemetryClient's flush() reports in its
 *                     `sent` array. A failed flush leaves this untouched.
 *   - linesConfirmed / completedAt: bookkeeping for the retention-floor and
 *     already-fully-delivered fast paths below.
 *
 * DETERMINISTIC recordId = sha256(`${projectHash}|${filename}|${byteOffset}`)
 * .slice(0, 16). Because it's a pure function of WHERE the line sits in the
 * file (never a random id, never file content), re-deriving it after a
 * watermark rewind reproduces the exact same id telemetryClient already
 * holds/held — so a rewind is harmless (the client's own recordId dedup
 * absorbs the resend) instead of duplicating records.
 *
 * BOOT RECONCILIATION (reconcileWatermarks, the anti-loss half): for any
 * file where bytesConfirmed < bytesEnqueued, re-derive the recordIds for the
 * bytes in that gap (cheap: recordId is a pure function of byte offset) and
 * ask telemetryClient whether each is still pending delivery or already in
 * its durable sent-set. Only when a record is in NEITHER (lost to queue
 * eviction, or a corrupt queue file) do we rewind bytesEnqueued back down to
 * bytesConfirmed so the next drain re-sends it.
 *
 * projectHash = sha256(normalizedProjectRoot).slice(0, 12) — same formula as
 * telemetryClient.cjs's internal hashCwd (kept as an independent literal
 * here, not a shared require, for the same reason opsErrorLog.cjs keeps its
 * own REDACT_KEY copy: this module must have no dependency on telemetry
 * client internals beyond its public ingest/egress contract). Keying the
 * watermark file by hash rather than raw path means the one on-disk artifact
 * this feature adds never itself stores a user's directory layout.
 *
 * Every entry point here is wrapped so it can never throw and never blocks
 * app startup — telemetry failing must stay completely invisible to the user.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config.cjs');

const DEFAULT_LIMIT = 500;
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const FILE_DATE_RE = /^errors-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const NEWLINE = 0x0a;

/** Module-singleton cache of the most recent drainBacklog() summary, for the Settings inspector. */
let lastSummary = null;

function lastRunSummary() {
  return lastSummary ? { ...lastSummary } : null;
}

function watermarksPath() {
  return path.join(os.homedir(), '.config', 'session-manager', 'telemetry-watermarks.json');
}

function resolveDeps(deps = {}) {
  return {
    sessionsStore: deps.sessionsStore || require('../sessionsStore.cjs'),
    isEphemeralCwd: deps.isEphemeralCwd || require('./ephemeralCwd.cjs').isEphemeralCwd,
    resolveProjectContext: deps.resolveProjectContext || require('./projectRootResolve.cjs').resolveProjectContext,
    telemetryClient: deps.telemetryClient || require('./telemetryClient.cjs'),
    opsErrorLog: deps.opsErrorLog || require('./opsErrorLog.cjs'),
    config: deps.config || config,
    fs: deps.fs || fs,
    fsp: deps.fsp || fsp,
  };
}

function projectHashOf(normalizedCwd) {
  return crypto.createHash('sha256').update(String(normalizedCwd)).digest('hex').slice(0, 12);
}

function recordIdFor(projectHash, filename, byteOffset) {
  return crypto.createHash('sha256').update(`${projectHash}|${filename}|${byteOffset}`).digest('hex').slice(0, 16);
}

function watermarkKey(projectHash, filename) {
  return `${projectHash}/${filename}`;
}

// ─── watermark persistence ─────────────────────────────────────────────

async function loadWatermarks(deps) {
  try {
    const raw = await deps.fsp.readFile(watermarksPath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    return {};
  } catch {
    // Missing or corrupt watermarks file is treated as empty, never fatal —
    // worst case is a full (idempotent, deduped-by-recordId) re-drain.
    return {};
  }
}

async function saveWatermarks(deps, wm) {
  try {
    await deps.config.writeJson(watermarksPath(), wm);
  } catch {
    /* best-effort — a failed watermark write must never throw out of a boot path */
  }
}

function entryFor(wm, key) {
  const e = wm[key];
  if (e && typeof e === 'object') {
    return {
      bytesEnqueued: Number.isFinite(e.bytesEnqueued) ? e.bytesEnqueued : 0,
      bytesConfirmed: Number.isFinite(e.bytesConfirmed) ? e.bytesConfirmed : 0,
      linesConfirmed: Number.isFinite(e.linesConfirmed) ? e.linesConfirmed : 0,
      completedAt: typeof e.completedAt === 'string' ? e.completedAt : null,
    };
  }
  return { bytesEnqueued: 0, bytesConfirmed: 0, linesConfirmed: 0, completedAt: null };
}

// ─── project + file enumeration ────────────────────────────────────────

/**
 * Known projects come from the same source of truth the renderer restores
 * tabs from (sessionsStore.cjs's ~/.config/session-manager/tabs.json — TAB =
 * cwd = Main Project), deduped by normalized cwd, with ephemeral (worktree /
 * tmpdir) cwds excluded before normalization even runs, since a worktree cwd
 * would otherwise resolve back to its real project and be scanned twice
 * under two identities. A cwd that no longer exists on disk is skipped, not
 * thrown on.
 */
async function enumerateProjectCwds(deps) {
  const cwds = [];
  const seen = new Set();
  let tabs = [];
  try {
    const loaded = await deps.sessionsStore.load();
    tabs = Array.isArray(loaded?.tabs) ? loaded.tabs : [];
  } catch {
    return cwds;
  }
  for (const tab of tabs) {
    const rawCwd = tab && typeof tab.cwd === 'string' ? tab.cwd : '';
    if (!rawCwd || !path.isAbsolute(rawCwd)) continue;
    if (deps.isEphemeralCwd(rawCwd)) continue;
    let normalized;
    try {
      normalized = deps.resolveProjectContext({ cwd: rawCwd }).cwd || rawCwd;
    } catch {
      normalized = rawCwd;
    }
    if (!normalized || deps.isEphemeralCwd(normalized)) continue;
    if (seen.has(normalized)) continue;
    let exists = false;
    try {
      exists = deps.fs.existsSync(normalized);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    seen.add(normalized);
    cwds.push(normalized);
  }
  return cwds;
}

/** Oldest-first errors-YYYY-MM-DD.jsonl listing for one project's logs dir. */
function listLogFiles(deps, cwd) {
  const dir = deps.opsErrorLog.logsDir(cwd);
  let names;
  try {
    names = deps.fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const m = FILE_DATE_RE.exec(name);
    if (!m) continue;
    const dateMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    files.push({ name, dateMs, fullPath: path.join(dir, name) });
  }
  files.sort((a, b) => a.dateMs - b.dateMs);
  return files;
}

// ─── line parsing (byte-accurate, read-only) ───────────────────────────

/**
 * Splits `buffer` into complete ('\n'-terminated) lines starting at
 * `fromByte`. A trailing partial line (no newline yet — an in-progress
 * write to today's file) is left unconsumed: neither counted nor advanced
 * past, so the next drain picks it up once it's complete. O(n) in the
 * scanned byte range.
 */
function splitCompleteLines(buffer, fromByte) {
  const lines = [];
  let searchStart = fromByte;
  while (true) {
    const idx = buffer.indexOf(NEWLINE, searchStart);
    if (idx === -1) break;
    lines.push({
      text: buffer.toString('utf8', searchStart, idx),
      startByte: searchStart,
      endByte: idx + 1,
    });
    searchStart = idx + 1;
  }
  return lines;
}

function levelFor(parsed) {
  return parsed && parsed.level === 'warn' ? 'warn' : 'error';
}

async function reportLine(deps, { cwd, filename, recordId, parsed }) {
  const level = levelFor(parsed);
  const scope = (parsed && parsed.scope) || 'unknown';
  const tags = Array.isArray(parsed && parsed.tags) ? parsed.tags : [];
  const context = {
    scope,
    tags,
    cwd,
    tabId: parsed.tabId || null,
    epicId: parsed.epicId || null,
    backlogFile: filename,
  };
  if (level === 'warn') {
    return deps.telemetryClient.logLine({ recordId, level: 'warn', msg: `backlog:${scope}`, fields: context });
  }
  return deps.telemetryClient.reportError({ recordId, name: scope || 'backlogError', msg: `backlog:${scope}`, context });
}

// ─── drain ──────────────────────────────────────────────────────────────

/**
 * drainBacklog({ now, limit, deps, reason }) — the main entry point.
 *
 * For every known, non-ephemeral project (oldest log file first within each
 * project), reads lines from the current bytesEnqueued watermark forward,
 * hands each to telemetryClient, then flushes once and advances
 * bytesConfirmed for the contiguous prefix of lines flush() reports as
 * `sent`. Bounded by `limit` lines total per call (default 500) so months of
 * backlog can't emit one enormous burst — the remainder is picked up by the
 * next call. Files older than the 30-day retention floor are stamped
 * completed WITHOUT ever being opened for read. Never throws.
 */
async function drainBacklog({ now = Date.now(), limit = DEFAULT_LIMIT, deps: depsOverride, reason = 'boot' } = {}) {
  const deps = resolveDeps(depsOverride);
  const summary = {
    projectsScanned: 0,
    filesScanned: 0,
    linesEnqueued: 0,
    linesConfirmed: 0,
    linesSkipped: 0,
    filesCompleted: 0,
    watermarksRewound: 0,
    reason,
  };

  try {
    const reconcileSummary = await reconcileWatermarks({ now, deps: depsOverride });
    summary.watermarksRewound += reconcileSummary.watermarksRewound;
  } catch {
    /* reconciliation must never block a drain attempt */
  }

  let wm;
  try {
    wm = await loadWatermarks(deps);
  } catch {
    wm = {};
  }

  let budget = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const cutoffMs = now - RETENTION_MS;

  let cwds = [];
  try {
    cwds = await enumerateProjectCwds(deps);
  } catch {
    cwds = [];
  }

  for (const cwd of cwds) {
    summary.projectsScanned += 1;
    const projectHash = projectHashOf(cwd);
    let files = [];
    try {
      files = listLogFiles(deps, cwd);
    } catch {
      files = [];
    }

    for (const file of files) {
      if (budget <= 0) break;
      const key = watermarkKey(projectHash, file.name);
      const entry = entryFor(wm, key);

      if (file.dateMs < cutoffMs) {
        // Retention floor: adoption never backfills ancient history, and the
        // file is never even stat'd to compute this.
        if (!entry.completedAt) {
          wm[key] = { ...entry, completedAt: new Date(now).toISOString() };
          summary.filesCompleted += 1;
        }
        continue;
      }

      let stat;
      try {
        stat = deps.fs.statSync(file.fullPath);
      } catch {
        continue; // file vanished under us — skip, don't throw
      }
      const size = stat.size;

      if (entry.completedAt && size === entry.bytesEnqueued) {
        // Fully confirmed and unchanged since — skipped without being
        // re-opened (only a cheap stat, never a content read).
        continue;
      }

      summary.filesScanned += 1;

      // Truncation/rotation safety: current size smaller than what we'd
      // already claimed to have enqueued means the file was truncated —
      // re-read from zero rather than seeking past EOF. A completed file
      // whose size has since changed (append past completion, or
      // truncation) is no longer "done" — it needs to be re-examined.
      let bytesEnqueued = entry.bytesEnqueued;
      let bytesConfirmed = entry.bytesConfirmed;
      if (size < bytesEnqueued) {
        bytesEnqueued = 0;
        bytesConfirmed = 0;
      }

      if (bytesConfirmed >= size && size > 0) {
        wm[key] = { ...entry, bytesEnqueued: size, bytesConfirmed: size, completedAt: new Date(now).toISOString() };
        summary.filesCompleted += 1;
        continue;
      }

      if (bytesEnqueued >= size) {
        // Nothing new since last drain.
        wm[key] = { ...entry, bytesEnqueued, bytesConfirmed, completedAt: null };
        continue;
      }

      let buffer;
      try {
        buffer = await deps.fsp.readFile(file.fullPath);
      } catch {
        continue;
      }

      const lines = splitCompleteLines(buffer, bytesEnqueued);
      const enqueuedThisFile = []; // { startByte, endByte, recordId }
      let cursor = bytesEnqueued;

      for (const line of lines) {
        if (budget <= 0) break;
        budget -= 1;
        cursor = line.endByte;

        let parsed = null;
        try {
          parsed = line.text.trim() ? JSON.parse(line.text) : null;
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed !== 'object') {
          summary.linesSkipped += 1;
          continue;
        }

        const recordId = recordIdFor(projectHash, file.name, line.startByte);
        try {
          const result = await reportLine(deps, { cwd, filename: file.name, recordId, parsed });
          if (result && result.accepted) summary.linesEnqueued += 1;
          // Tracked for confirmation-prefix checking regardless of `accepted`
          // — a 'duplicate'/dedup rejection just means telemetryClient
          // already has (or already sent) this exact recordId, which the
          // sentIds check below verifies independently.
          enqueuedThisFile.push({ startByte: line.startByte, endByte: line.endByte, recordId });
        } catch {
          summary.linesSkipped += 1;
        }
      }

      bytesEnqueued = cursor;
      wm[key] = { ...entry, bytesEnqueued, bytesConfirmed, completedAt: null };
      await saveWatermarks(deps, wm);

      if (enqueuedThisFile.length > 0) {
        let flushResult = { sent: [], failed: [] };
        try {
          flushResult = await deps.telemetryClient.flush('manual');
        } catch {
          flushResult = { sent: [], failed: [] };
        }
        const sentIds = new Set(flushResult.sent || []);

        // Advance bytesConfirmed only across the CONTIGUOUS prefix (by byte
        // offset) of lines this round that were actually confirmed sent —
        // a gap (e.g. a later record's channel flushed but an earlier
        // record's channel didn't) must stop the advance right there.
        let confirmedThrough = bytesConfirmed;
        for (const rec of enqueuedThisFile) {
          if (rec.startByte !== confirmedThrough) break; // gap from a prior unconfirmed record
          if (!sentIds.has(rec.recordId)) break;
          confirmedThrough = rec.endByte;
          summary.linesConfirmed += 1;
        }
        bytesConfirmed = confirmedThrough;

        const finalEntry = { ...entry, bytesEnqueued, bytesConfirmed, completedAt: null };
        if (bytesConfirmed >= size) {
          finalEntry.completedAt = new Date(now).toISOString();
          summary.filesCompleted += 1;
        }
        wm[key] = finalEntry;
        await saveWatermarks(deps, wm);
      }

      // Yield between files so a large backlog never blocks the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  lastSummary = { ...summary, ranAt: new Date(now).toISOString() };
  return summary;
}

// ─── boot reconciliation (anti-loss) ───────────────────────────────────

/**
 * reconcileWatermarks({ now, deps }) — for any file whose watermark shows
 * bytesConfirmed < bytesEnqueued, re-derives the recordIds for the bytes in
 * that gap and checks whether telemetryClient still has each one pending, or
 * already recorded as sent. Only when a record is in NEITHER (queue
 * eviction, or a corrupt queue/sent file) is bytesEnqueued rewound back down
 * to bytesConfirmed so the next drainBacklog() call re-sends it. Never
 * throws.
 */
async function reconcileWatermarks({ now = Date.now(), deps: depsOverride } = {}) {
  const deps = resolveDeps(depsOverride);
  const summary = { watermarksRewound: 0 };

  let wm;
  try {
    wm = await loadWatermarks(deps);
  } catch {
    return summary;
  }

  let sentIds = new Set();
  try {
    const raw = await deps.fsp.readFile(deps.telemetryClient.sentPath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.ids)) sentIds = new Set(data.ids);
  } catch {
    sentIds = new Set();
  }

  let cwds = [];
  try {
    cwds = await enumerateProjectCwds(deps);
  } catch {
    cwds = [];
  }

  const cwdByHash = new Map();
  for (const cwd of cwds) cwdByHash.set(projectHashOf(cwd), cwd);

  let changed = false;
  for (const key of Object.keys(wm)) {
    const slash = key.indexOf('/');
    if (slash === -1) continue;
    const projectHash = key.slice(0, slash);
    const filename = key.slice(slash + 1);
    const cwd = cwdByHash.get(projectHash);
    if (!cwd) continue; // project no longer known — leave watermark as-is

    const entry = entryFor(wm, key);
    if (entry.bytesConfirmed >= entry.bytesEnqueued) continue;

    const filePath = path.join(deps.opsErrorLog.logsDir(cwd), filename);
    let buffer;
    try {
      buffer = await deps.fsp.readFile(filePath);
    } catch {
      continue; // can't verify without the file — leave as-is rather than guess
    }

    const gapEnd = Math.min(entry.bytesEnqueued, buffer.length);
    const lines = splitCompleteLines(buffer.subarray(0, gapEnd), entry.bytesConfirmed);
    if (lines.length === 0) continue;

    let allAccountedFor = true;
    for (const line of lines) {
      const recordId = recordIdFor(projectHash, filename, line.startByte);
      let pending = false;
      try {
        pending = await deps.telemetryClient.isPending(recordId);
      } catch {
        pending = false;
      }
      if (pending || sentIds.has(recordId)) continue;
      allAccountedFor = false;
      break;
    }

    if (!allAccountedFor) {
      wm[key] = { ...entry, bytesEnqueued: entry.bytesConfirmed };
      summary.watermarksRewound += 1;
      changed = true;
    }
  }

  if (changed) await saveWatermarks(deps, wm);
  return summary;
}

// ─── boot wiring (the WHEN, mirroring telemetryBoot.cjs's own split) ────

/**
 * bootDrain({ now, appVersion, deps }) — the call site index.cjs's
 * `ready-to-show` handler invokes: always drains once with reason 'boot',
 * and — the FIRST time this appVersion has ever been seen by the drainer
 * (tracked in the watermarks file's own `_meta.lastDrainVersion`, so this
 * module owns its own version-change bookkeeping rather than reaching into
 * telemetrySettings.json's strict, unrelated schema) — drains a second time
 * tagged reason 'version-change'. The second pass is cheap even when
 * nothing new exists to send: every file it would touch was already
 * advanced by the first pass in this same call, so it's a no-op scan.
 * Never throws.
 */
async function bootDrain({ now = Date.now(), appVersion, deps: depsOverride } = {}) {
  const deps = resolveDeps(depsOverride);
  const summary = await drainBacklog({ now, deps: depsOverride, reason: 'boot' });

  try {
    const wm = await loadWatermarks(deps);
    const meta = (wm && typeof wm._meta === 'object' && wm._meta) || {};
    if (appVersion && meta.lastDrainVersion !== appVersion) {
      await drainBacklog({ now, deps: depsOverride, reason: 'version-change' });
      const wm2 = await loadWatermarks(deps);
      wm2._meta = { ...(wm2._meta && typeof wm2._meta === 'object' ? wm2._meta : {}), lastDrainVersion: appVersion };
      await saveWatermarks(deps, wm2);
    }
  } catch {
    /* version-change bookkeeping must never block the ordinary boot drain above */
  }

  return summary;
}

module.exports = {
  drainBacklog,
  reconcileWatermarks,
  bootDrain,
  watermarksPath,
  lastRunSummary,
  // exported for unit tests only
  _projectHashOf: projectHashOf,
  _recordIdFor: recordIdFor,
  _enumerateProjectCwds: enumerateProjectCwds,
};
