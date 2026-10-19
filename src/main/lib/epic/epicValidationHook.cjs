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

/**
 * buildSettledDigest — pure builder for the ONE plan-digest prompt.
 * Empty sections are omitted. `notValidatedReason` explains why the
 * settle.uncovered slugs were not sent to a sweep validator.
 */
function buildSettledDigest(settle, { epicId, notValidatedReason } = {}) {
  const s = settle || {};
  const verified = s.verified || [];
  const refuted = s.refuted || [];
  const failed = s.failed || [];
  const parked = s.parked || [];
  const cancelled = s.cancelled || [];
  const notValidated = (s.uncovered || []).map((u) => (typeof u === 'string' ? u : u.slug));
  const lines = [
    `PLAN SETTLED — no PRD of this session is pending or running. This is ONE digest, not a per-PRD request.`,
    `Validation record folder: session-manager-operations/reviews/validation/${epicId}/`,
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
 * Never throws. Actions: 'none' | 'sweep-queued' | 'digest-sent'.
 */
async function runEpicSettle({ cwd, epicId } = {}, deps = {}) {
  const {
    readActiveIndex = defaultReadActiveIndex,
    loadJobs = async () => [],
    loadHistory = async () => [],
    createPrd,
    resolveBaseSha = async () => null,
    sendPrompt,
    appendResponseEvent,
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
      const candidates = settle.uncovered.filter((u) => !swept.has(u.bareSlug || bareSlug(u.slug)));
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
        const { input } = buildSweepValidatorInput({ epicId, cwd, uncovered: candidates, baseSha, now: now() });
        let res;
        try {
          res = await createPrd(input);
        } catch (e) {
          res = { ok: false, error: e && e.message ? e.message : String(e) };
        }
        if (res && res.ok) return { action: 'sweep-queued', slug: input.slug };
        notValidatedReason = `the validator persona could not be queued: ${(res && res.error) || 'unknown error'}`;
      } else {
        notValidatedReason = 'a sweep validator already ran and did not check them';
      }
    }

    const prompt = buildSettledDigest(digestSettle, { epicId, notValidatedReason });
    sendPrompt(epicId, prompt);
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
