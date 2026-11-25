'use strict';

/**
 * prdOutcomeRecord.cjs — one structured outcome record per finished PRD run
 * (Managed Agents' "outcome", kept local).
 *
 * Layout: session-manager-operations/scheduler/epics/<epicId>/outcomes/<slug>.json
 *   { schemaVersion, slug, epicId, recordedAt, verdict, commits, files, gates, checks, ...extra }
 * Written atomically (util/atomicFs) as the 'scheduler' namespace owner; the
 * latest terminal run of a slug overwrites the previous record. After the
 * write, one `outcome.recorded` { slug, verdict } event is appended to the
 * Epic's event log (lib/epic/epicEventLog.cjs). An event-append failure is
 * logged, never thrown — the record on disk is the source of truth.
 *
 * `verdict` is the job's terminal status (completed / failed / needs_review);
 * the verifier's own verdict string travels inside `gates`.
 */

const path = require('node:path');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const { writeJsonAtomic, writeTextAtomic, readJsonOr } = require('../util/atomicFs.cjs');

const WRITER = 'scheduler';
const SCHEMA_VERSION = 1;
const EPIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_FILES = 500;
const MAX_COMMITS = 100;

function assertIds(epicId, slug) {
  if (typeof epicId !== 'string' || !EPIC_ID_RE.test(epicId)) throw new Error(`prdOutcomeRecord: invalid epicId "${epicId}"`);
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.includes('..')) throw new Error(`prdOutcomeRecord: invalid slug "${slug}"`);
}

/** Absolute path of a slug's outcome record. Throws on an unsafe epicId/slug. */
function outcomeRecordPath(cwd, epicId, slug) {
  assertIds(epicId, slug);
  return opsPath(cwd, 'scheduler', 'epics', epicId, 'outcomes', `${slug}.json`);
}

function strList(v, cap) {
  return (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x).slice(0, cap);
}
function objList(v) {
  return (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object');
}

/**
 * writeOutcomeRecord({ cwd, epicId, slug, commits, files, gates, checks, verdict, extra?, write?, appendEvent? })
 *   → Promise<string> (the written path). Rejects on a bad id or write failure.
 */
async function writeOutcomeRecord({
  cwd, epicId, slug, commits, files, gates, checks, verdict, extra = null,
  write = writeJsonAtomic, appendEvent = null,
} = {}) {
  const file = outcomeRecordPath(cwd, epicId, slug);
  assertOpsWrite(file, WRITER);
  const record = {
    ...(extra && typeof extra === 'object' ? extra : {}),
    schemaVersion: SCHEMA_VERSION,
    slug,
    epicId,
    recordedAt: new Date().toISOString(),
    verdict: verdict == null ? null : String(verdict),
    commits: strList(commits, MAX_COMMITS),
    files: strList(files, MAX_FILES),
    gates: objList(gates),
    checks: objList(checks),
  };
  await write(file, record);
  try {
    const append = appendEvent || require('../epic/epicEventLog.cjs').appendEpicEvent;
    await append(cwd, epicId, { kind: 'outcome.recorded', slug, verdict: record.verdict });
  } catch (e) {
    console.error('[prdOutcomeRecord] outcome.recorded event append failed', epicId, slug, e && e.message ? e.message : e);
  }
  return file;
}

/**
 * mergeOutcomeChecks({ cwd, epicId, slug, checks, write? }) → Promise<boolean>
 * (true when a record was rewritten). Replaces the existing record's `checks`
 * entries by id with the fresh ones (each stamped ranAt + stage
 * 'validator-dispatch' unless already stamped), keeps every other entry, and
 * writes atomically as 'scheduler'. No record on disk → no write. Never throws.
 */
async function mergeOutcomeChecks({ cwd, epicId, slug, checks, write = writeJsonAtomic } = {}) {
  try {
    const file = outcomeRecordPath(cwd, epicId, slug);
    const record = await readJsonOr(file, null);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const ranAt = new Date().toISOString();
    const fresh = objList(checks)
      .filter((c) => typeof c.id === 'string' && c.id)
      .map((c) => ({ ...c, ranAt: c.ranAt || ranAt, stage: c.stage || 'validator-dispatch' }));
    const freshById = new Map(fresh.map((c) => [c.id, c]));
    const merged = [];
    const seen = new Set();
    for (const c of objList(record.checks)) {
      if (typeof c.id === 'string' && freshById.has(c.id)) {
        if (!seen.has(c.id)) { merged.push(freshById.get(c.id)); seen.add(c.id); }
      } else merged.push(c);
    }
    for (const c of fresh) if (!seen.has(c.id)) { merged.push(c); seen.add(c.id); }
    assertOpsWrite(file, WRITER);
    await write(file, { ...record, checks: merged });
    return true;
  } catch (e) {
    console.error('[prdOutcomeRecord] mergeOutcomeChecks failed', epicId, slug, e && e.message ? e.message : e);
    return false;
  }
}

/**
 * writeCheckBody({ cwd, epicId, slug, id, body, write? }) → Promise<string|null>.
 * Writes one http check's response body to
 * scheduler/epics/<epicId>/outcomes/<slug>.bodies/<id>.txt (atomic, writer
 * 'scheduler'; overwritten per id, so each check keeps one copy). Returns the
 * absolute path, or null on a bad id / write failure. Never throws. The
 * directory lives under the Epic's scheduler folder, so epicPurge removes it
 * with the outcome records.
 */
async function writeCheckBody({ cwd, epicId, slug, id, body, write = writeTextAtomic } = {}) {
  try {
    assertIds(epicId, slug);
    if (typeof id !== 'string' || !SLUG_RE.test(id) || id.includes('..')) throw new Error(`invalid check id "${id}"`);
    if (typeof body !== 'string') throw new Error('body must be a string');
    const file = opsPath(cwd, 'scheduler', 'epics', epicId, 'outcomes', `${slug}.bodies`, `${id}.txt`);
    assertOpsWrite(file, WRITER);
    await write(file, body);
    return file;
  } catch (e) {
    console.error('[prdOutcomeRecord] writeCheckBody failed', epicId, slug, id, e && e.message ? e.message : e);
    return null;
  }
}

/**
 * Pure: derive { verdict, commits, files, gates, checks } from a finalized
 * job row plus the run's verifyResult. `gates` holds the verifier verdict
 * (always) and the row's gate re-run (gateShadow) when one is recorded;
 * `checks` holds the structured-criteria results when present.
 */
function buildOutcomeFromJob({ job, verifyResult = null, commits = [], files = [] }) {
  const j = job || {};
  /** @type {Array<Record<string, unknown>>} */
  const gates = [{
    source: 'verifier',
    verdict: (verifyResult && verifyResult.verdict) || j.verifierVerdict || (j.exitCode === 0 ? 'clean' : null),
    reason: (verifyResult && verifyResult.reason) || j.error || null,
    exitCode: j.exitCode ?? null,
    terminalReason: j.terminalReason ?? null,
  }];
  const shadow = j.gateShadow && typeof j.gateShadow === 'object' ? j.gateShadow : null;
  if (shadow) {
    gates.push({
      source: `gate:${shadow.source ?? 'prd'}`,
      status: shadow.status ?? null,
      head: shadow.head ?? null,
      ranAt: shadow.ranAt ?? null,
      results: Array.isArray(shadow.results) ? shadow.results : [],
    });
  }
  let checks = [];
  if (shadow && Array.isArray(shadow.criteriaChecks)) checks = shadow.criteriaChecks;
  else if (j.criteriaChecks && Array.isArray(j.criteriaChecks.results)) checks = j.criteriaChecks.results;
  return { verdict: j.status ?? null, commits, files, gates, checks };
}

/**
 * Files touched by `shas` in `cwd` (union, sorted). Never throws — a git
 * error yields whatever was collected so far.
 */
async function listCommitFiles(cwd, shas) {
  const { execGit } = require('../git/gitExec.cjs');
  const out = new Set();
  for (const sha of strList(shas, MAX_COMMITS)) {
    try {
      const text = await execGit(cwd, ['show', '--name-only', '--format=', '--no-renames', sha], { timeout: 10_000 });
      for (const line of String(text).split('\n')) {
        const p = line.trim();
        if (p) out.add(p.split(path.sep).join('/'));
      }
    } catch { /* unknown sha / non-git cwd */ }
  }
  return [...out].sort().slice(0, MAX_FILES);
}

module.exports = {
  writeOutcomeRecord, mergeOutcomeChecks, writeCheckBody, outcomeRecordPath, buildOutcomeFromJob, listCommitFiles, SCHEMA_VERSION,
};
