'use strict';

/**
 * epicValidationHook.cjs — the Epic settle runner: once an Epic has no
 * pending/running PRD it either queues ONE headless sweep validator for
 * unchecked completed PRDs, or sends ONE plan digest into the Epic's chat.
 *
 * WHY validation exists (PRD 986): PRD 972 ran 34 s, made zero edits, exited 0,
 * and the queue recorded `completed` — a job's self-report is never proof.
 *
 * Kill-switch: SM_EPIC_VALIDATION_DISABLE=1 turns the whole runner off.
 * SM_EPIC_SETTLE_SECONDS sets the debounce before a settle run (default 120).
 *
 * A sweep covers what fits one budget; the rest go to the next settle.
 *
 * This module spawns NO process itself: the sweep validator is a PRD queued
 * through the scheduler (which acquires a lib/scheduler/sessionSlots.cjs slot),
 * and the digest goes through the chat queue's pump, which does the same.
 *
 * Join-only: nothing here can create an Epic (epicMint.cjs's SINGLE-CREATOR
 * LAW). If no active authoring Epic exists, do nothing.
 */

const fs = require('node:fs');
const path = require('node:path');
const { evaluateEpicSettle } = require('./epicSettle.cjs');
const { buildSweepValidatorInput, isSweepValidatorSlug } = require('./epicSweepValidator.cjs');
const { bareSlug } = require('../prd/depSlugResolve.cjs');

/**
 * Default active-index reader: the same on-disk file
 * promptSessionEvents.cjs writes. Read-only here (no lock needed — a torn
 * read degrades to "skip", never to a bad write). Returns null on any
 * error/missing file so callers treat it as "no active Epic".
 */
function defaultReadActiveIndex(cwd) {
  try {
    const { opsPath } = require('../opsOwnership.cjs');
    const p = opsPath(cwd, 'prompt-sessions', 'active-index.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** The digest's record-folder lines: absolute main-checkout paths when cwd resolves. */
function recordFolderLines(cwd, epicId) {
  try {
    if (typeof cwd === 'string' && cwd) {
      const { opsPath } = require('../opsOwnership.cjs');
      return [
        `Plan record folder (on disk in the main checkout, not committed): ${opsPath(cwd, 'plan-records', epicId)}${path.sep}`,
        `Legacy validation record folder: ${opsPath(cwd, 'reviews', 'validation', epicId)}${path.sep}`,
      ];
    }
  } catch { /* fall through to the relative form */ }
  return [
    `Plan record folder (relative to the project root): session-manager-operations/plan-records/${epicId}/`,
    `Legacy validation record folder: session-manager-operations/reviews/validation/${epicId}/`,
  ];
}

/**
 * buildSettledDigest — pure builder for the ONE plan-digest prompt.
 * Empty sections are omitted. `notValidatedReason` explains why the
 * settle.uncovered slugs were not sent to a sweep validator. `cwd` is the
 * project root: plan records live on disk in its main checkout
 * (plan-records/<epicId>/, never committed), so the digest names that
 * absolute folder plus the legacy reviews/validation/<epicId>/ one.
 */
const SEVERITY_ORDER = ['Critical', 'Important', 'Minor'];
const MAX_FINDING_LINES = 50;

function severityRank(sev) {
  const i = SEVERITY_ORDER.indexOf(String(sev || ''));
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/** Collapse every whitespace run (newlines, tabs) to one space and trim. */
function oneLine(x) {
  return String(x ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Findings section lines: every finding gets an outcome in the same turn —
 * Minor ones are the ones that get dropped when only verdict slugs are listed.
 * Critical first, then Important, then Minor (stable within a severity).
 */
function findingLines(findings) {
  const list = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f === 'object');
  if (!list.length) return [];
  const sorted = list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (severityRank(a.f.severity) - severityRank(b.f.severity)) || (a.i - b.i))
    .map((x) => x.f);
  const shown = sorted.slice(0, MAX_FINDING_LINES);
  const out = [
    '', `Findings (${list.length}) — give each one an outcome in this turn: a fix PRD or a one-line close reason:`,
    ...shown.map((f) => {
      const text = oneLine(f.text);
      const file = oneLine(f.file);
      return `- [${oneLine(f.severity)}] ${oneLine(f.prd)}:${text ? ` ${text}` : ''}${file ? ` (${file})` : ''}`;
    }),
  ];
  if (sorted.length > shown.length) out.push(`- …and ${sorted.length - shown.length} more in the records`);
  return out;
}

/**
 * Flatten verdict records ({ prd, at, findings[] }) to digest findings, keeping
 * only verdicts saved after `sinceMs` (null = keep all). A verdict with no
 * parseable `at` is kept only when there is no previous digest.
 */
function collectFindings(verdicts, sinceMs) {
  const out = [];
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    if (!v || !Array.isArray(v.findings) || !v.findings.length) continue;
    if (sinceMs != null) {
      const t = typeof v.at === 'string' ? Date.parse(v.at) : NaN;
      if (!Number.isFinite(t) || t <= sinceMs) continue;
    }
    for (const f of v.findings) {
      if (!f || typeof f !== 'object') continue;
      out.push({ prd: v.prd, severity: f.severity, text: f.text, file: f.file });
    }
  }
  return out;
}

function defaultReadVerdictFiles(cwd, epicId) {
  try {
    return require('./epicOutsideRead.cjs').readVerdictFiles(cwd, epicId);
  } catch {
    return [];
  }
}

function buildSettledDigest(settle, { epicId, notValidatedReason, cwd, findings } = {}) {
  const s = settle || {};
  const verified = s.verified || [];
  const refuted = s.refuted || [];
  const failed = s.failed || [];
  const parked = s.parked || [];
  const cancelled = s.cancelled || [];
  const notValidated = (s.uncovered || []).map((u) => (typeof u === 'string' ? u : u.slug));
  const held = Array.isArray(s.held) ? s.held : [];
  const head = held.length
    ? [
      `PLAN SETTLED — nothing of this session is running; ${held.length} PRD(s) are held on a precondition and will run on their own:`,
      ...held.map((h) => `- ${h.slug}${h.reason ? ` — ${h.reason}` : ''}`),
      'This is ONE digest, not a per-PRD request.',
    ]
    : [`PLAN SETTLED — no PRD of this session is pending or running. This is ONE digest, not a per-PRD request.`];
  const lines = [
    ...head,
    ...recordFolderLines(cwd, epicId),
    'Do NOT re-verify VERIFIED PRDs — a validator already checked them.',
  ];
  if (verified.length) {
    lines.push('', `Verified (${verified.length}):`, ...verified.map((v) => `- ${v}`));
  }
  if (refuted.length) {
    lines.push('', `REFUTED (${refuted.length}):`, ...refuted.map((r) => `- ${r.slug}${r.reason ? ` — ${r.reason}` : ''}`));
  }
  if (failed.length) {
    lines.push('', `Failed (${failed.length}):`, ...failed.map((f) => `- ${f}`));
  }
  if (parked.length) {
    lines.push('', `Parked (needs_review) (${parked.length}):`, ...parked.map((p) => `- ${p}`));
  }
  if (cancelled.length) {
    lines.push(
      '', `Cancelled (${cancelled.length}) — stopped by scheduler_cancel_job; only scheduler_reset_job revives them:`,
      ...cancelled.map((c) => `- ${c}`),
    );
  }
  lines.push(...findingLines(findings));
  if (notValidated.length) {
    lines.push(
      '', `Not validated (${notValidated.length}) — ${notValidatedReason || 'no validator checked them'}:`,
      ...notValidated.map((n) => `- ${n}`),
      `Validate these here: read each PRD file under session-manager-operations/scheduler/epics/${epicId}/prds-archived/ by slug, check every acceptance criterion against the working tree, and reply VERIFIED or REFUTED per slug.`,
    );
  }
  return lines.join('\n');
}

const DEFAULT_SETTLE_SECONDS = 120;

function settleDelayMs() {
  const raw = process.env.SM_EPIC_SETTLE_SECONDS;
  const n = /^\d+$/.test(String(raw || '').trim()) ? parseInt(String(raw).trim(), 10) : 0;
  return (n > 0 ? n : DEFAULT_SETTLE_SECONDS) * 1000;
}

const _rowInEpic = (r, epicId) => r && (r.epicId === epicId || r.sourcePromptId === epicId);

/**
 * runEpicSettle({ cwd, epicId }, deps) → { action, reason?, slug? }
 * Never throws. Actions: 'none' | 'sweep-queued' | 'digest-sent' | 'digest-held'.
 */
async function runEpicSettle({ cwd, epicId } = {}, deps = {}) {
  const {
    readActiveIndex = defaultReadActiveIndex,
    loadJobs = async () => [],
    loadHistory = async () => [],
    createPrd,
    resolveBaseSha = async () => null,
    readGateMs = async () => new Map(),
    jobBudget,
    sendPrompt,
    appendResponseEvent,
    readVerdictFiles = defaultReadVerdictFiles,
    now = Date.now,
    log = console,
  } = deps;
  try {
    if (process.env.SM_EPIC_VALIDATION_DISABLE === '1') return { action: 'none', reason: 'disabled' };
    if (!cwd || !epicId) return { action: 'none', reason: 'missing-args' };

    const index = readActiveIndex(cwd);
    const session = index && index.sessions && index.sessions[epicId];
    if (!session || session.status !== 'active') return { action: 'none', reason: 'epic-not-active' };

    const events = (index.events && index.events[epicId]) || [];
    const jobs = (await loadJobs()) || [];
    const history = (await loadHistory()) || [];
    const settle = evaluateEpicSettle({ epicId, cwd, events, jobs, now: now() });
    if (!settle.settled) return { action: 'none', reason: 'not-settled' };
    if (!settle.hasContent) return { action: 'none', reason: 'no-content' };

    // Macro builds (rows carrying macroId): the artifact check and gate are the
    // done-check; no sweep validator, no digest chat turn.
    const macroSlugs = new Set();
    let epicRows = 0;
    for (const r of [...jobs, ...history]) {
      if (!_rowInEpic(r, epicId)) continue;
      epicRows++;
      if (typeof r.macroId === 'string' && r.macroId.trim()) macroSlugs.add(bareSlug(r.slug));
    }
    if (epicRows > 0 && [...jobs, ...history].every((r) => !_rowInEpic(r, epicId) || (typeof r.macroId === 'string' && r.macroId.trim()))) {
      return { action: 'none', reason: 'macro-build' };
    }

    let newestDigest = null;
    for (const e of events) if (e && e.outcome === 'digest') newestDigest = e;
    if (newestDigest && newestDigest.digestKey === settle.digestKey) {
      return { action: 'none', reason: 'already-digested' };
    }

    let notValidatedReason = null;
    let digestSettle = settle;
    if (settle.uncovered.length) {
      const swept = new Set();
      for (const r of [...jobs, ...history]) {
        if (!_rowInEpic(r, epicId) || !isSweepValidatorSlug(r.slug) || !Array.isArray(r.dependsOn)) continue;
        for (const d of r.dependsOn) swept.add(bareSlug(d));
      }
      const candidates = settle.uncovered.filter((u) => {
        const b = u.bareSlug || bareSlug(u.slug);
        return !swept.has(b) && !macroSlugs.has(b);
      });
      if (candidates.length) {
        const byBare = new Map();
        for (const h of history) {
          if (!h || !h.landedCommit || (h.cwd != null && h.cwd !== cwd)) continue;
          const b = bareSlug(h.slug);
          const prev = byBare.get(b);
          if (!prev || String(h.finishedAt) < String(prev.finishedAt)) byBare.set(b, h);
        }
        let earliest = null;
        for (const c of candidates) {
          const h = byBare.get(c.bareSlug || bareSlug(c.slug));
          if (h && (!earliest || String(h.finishedAt) < String(earliest.finishedAt))) earliest = h;
        }
        let baseSha = null;
        try { baseSha = earliest ? await resolveBaseSha(cwd, earliest.landedCommit) : null; } catch { baseSha = null; }
        let gateMap = new Map();
        try {
          const m = await readGateMs(cwd, epicId, candidates.map((c) => c.slug));
          if (m instanceof Map) gateMap = m;
        } catch (e) {
          try { (log || console).error('[epicValidationHook] readGateMs failed', epicId, e); } catch { /* noop */ }
        }
        const sized = candidates.map((c) => ({ ...c, gateMs: gateMap.get(c.slug) }));
        const { input, carried } = buildSweepValidatorInput({ epicId, cwd, uncovered: sized, baseSha, now: now(), jobBudget });
        let res;
        try {
          res = await createPrd(input);
        } catch (e) {
          res = { ok: false, error: e && e.message ? e.message : String(e) };
        }
        if (res && res.ok) return { action: 'sweep-queued', slug: input.slug, carried: carried.length };
        notValidatedReason = `the validator persona could not be queued: ${(res && res.error) || 'unknown error'}`;
      } else {
        notValidatedReason = 'a sweep validator already ran and did not check them';
      }
    }

    let findings = [];
    try {
      const sinceMs = newestDigest ? Date.parse(newestDigest.at) : null;
      findings = collectFindings(
        (await readVerdictFiles(cwd, epicId)) || [],
        sinceMs != null && Number.isFinite(sinceMs) ? sinceMs : null,
      );
    } catch (e) {
      try { (log || console).error('[epicValidationHook] readVerdictFiles failed', epicId, e); } catch { /* noop */ }
    }
    const prompt = buildSettledDigest(digestSettle, { epicId, notValidatedReason, cwd, findings });
    // A non-promise return or a rejected send counts as sent; only an explicit
    // 'held' disposition (usage hold kept the turn) is recorded as held. The
    // digestKey is kept either way so a later settle does not send a second one.
    const sent = await Promise.resolve(sendPrompt(epicId, prompt, { origin: 'scheduler', heldKind: 'settle-digest' })).catch(() => null);
    if (sent && sent.disposition === 'held') {
      await appendResponseEvent(
        cwd, epicId,
        'Plan digest held by the usage hold — it is delivered when the hold clears',
        { outcome: 'digest', digestKey: settle.digestKey, held: true },
      );
      return { action: 'digest-held' };
    }
    await appendResponseEvent(
      cwd, epicId,
      `Plan digest sent: ${settle.verified.length} verified, ${settle.refuted.length} refuted, ${settle.uncovered.length} not validated`,
      { outcome: 'digest', digestKey: settle.digestKey },
    );
    return { action: 'digest-sent' };
  } catch (e) {
    try { (log || console).error('[epicValidationHook] settle error', epicId, e); } catch { /* noop */ }
    return { action: 'none', reason: 'error' };
  }
}

const _settle = new Map(); // `${cwd}::${epicId}` -> { timer, running }

/**
 * scheduleEpicSettle({ cwd, epicId }, run, { delayMs }) — debounce per
 * (cwd, epicId): a new call resets the timer; timers are unref'd; a run in
 * flight is never started twice.
 */
function scheduleEpicSettle({ cwd, epicId } = {}, run, { delayMs } = {}) {
  if (!cwd || !epicId || typeof run !== 'function') return;
  const key = `${cwd}::${epicId}`;
  const entry = _settle.get(key) || { timer: null, running: false };
  _settle.set(key, entry);
  if (entry.timer) clearTimeout(entry.timer);
  const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : settleDelayMs();
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    if (entry.running) return;
    entry.running = true;
    try {
      await run({ cwd, epicId });
    } catch (e) {
      try { console.error('[epicValidationHook] settle run error', epicId, e); } catch { /* noop */ }
    } finally {
      entry.running = false;
      if (!entry.timer) _settle.delete(key);
    }
  }, delay);
  if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
}

/** Test hook: clear pending settle timers. */
function __resetSettleForTests() {
  for (const e of _settle.values()) if (e.timer) clearTimeout(e.timer);
  _settle.clear();
}

module.exports = {
  buildSettledDigest,
  runEpicSettle,
  scheduleEpicSettle,
  __resetSettleForTests,
};
