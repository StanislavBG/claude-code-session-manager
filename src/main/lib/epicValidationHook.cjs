'use strict';

/**
 * epicValidationHook.cjs — a PRD check-in triggers validation in the
 * authoring Epic; it never asserts the PRD is done (PRD 986).
 *
 * WHY: PRD 972 ran 34 s, made zero edits, exited 0, and the queue recorded
 * `completed`. Three layers of scheduler-side automation failed to notice.
 * The party with the context to judge whether the work is right is the Epic
 * that WROTE the PRD — so a check-in is inverted from "assertion of done"
 * into a REQUEST TO VALIDATE: when the scheduler appends a check-in response
 * event to the authoring Epic's chain, this hook enqueues ONE validation
 * prompt into that Epic's own chat session instructing it to independently
 * verify each acceptance criterion against the real working tree and answer
 * VERIFIED or REFUTED with evidence. The job's self-reported status is an
 * input to that check, never a substitute for it.
 *
 * Shape mirrors lib/dodDrainHook.cjs: fire-and-forget (never throws to the
 * caller — errors are logged), kill-switched, idempotent.
 *
 * Kill-switch: SM_EPIC_VALIDATION_DISABLE=1 (mirrors the SM_DOD_DISABLE
 * precedent) — turns the whole hook off without a code change.
 *
 * SESSION SLOT POOL: this module spawns NOTHING. The prompt is enqueued via
 * chatRunner.cjs's enqueueExternalPrompt → `chat:external-send` → the
 * renderer's chat queue → chatRunner's pump, which acquires a slot from the
 * machine-wide lib/sessionSlots.cjs pool (chatRunner.cjs pump()) before any
 * `claude -p` process starts. So the validation session cannot start outside
 * the pool — if the pool is exhausted the prompt simply waits in the chat
 * lane's FIFO, it never fans out into an extra parallel process (the
 * 2026-06-10 OOM shape this AC exists to prevent).
 *
 * Cost note: this spends tokens per PRD check-in — intended trade. The
 * once-per-(epicId, prdSlug) guard and the kill-switch keep it bounded.
 *
 * Join-only: nothing here can create an Epic (epicMint.cjs's SINGLE-CREATOR
 * LAW). If no active authoring Epic exists, log and do nothing.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * LOOP GUARD + once-per-pair bookkeeping.
 *
 * `_fired` records every (epicId, prdSlug) pair this process has already
 * enqueued a validation prompt for — the fast in-memory half of the
 * once-per-pair guard (the durable half re-reads the Epic's own event chain,
 * see maybeEnqueueValidationPrompt below).
 */
const _fired = new Set();

function pairKey(epicId, prdSlug) {
  return `${epicId}::${prdSlug}`;
}

/**
 * Default active-index reader: the same on-disk file
 * promptSessionEvents.cjs writes. Read-only here (no lock needed — a torn
 * read degrades to "skip", never to a bad write). Returns null on any
 * error/missing file so callers treat it as "no active Epic".
 */
function defaultReadActiveIndex(cwd) {
  try {
    const { opsPath } = require('./opsOwnership.cjs');
    const p = opsPath(cwd, 'prompt-sessions', 'active-index.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * buildValidationPrompt — pure prompt builder.
 *
 * The prompt must carry: the PRD slug, the absolute path to its .md, the
 * job's self-reported outcome explicitly labelled as an UNVERIFIED CLAIM,
 * the instruction to check every Acceptance Criterion against the actual
 * working tree, and the VERIFIED/REFUTED reply contract with per-criterion
 * evidence. It also warns against the exact failure mode that produced
 * PRD 986: exit 0 / a green queue row / a confident report are not evidence.
 */
function buildValidationPrompt({ prdSlug, prdPath, outcome }) {
  const pathLine = prdPath
    ? `PRD file (absolute path): ${prdPath}`
    : 'PRD file: path could not be resolved — locate it under session-manager-operations/scheduler/epics/*/prds-archived/ by slug.';
  return [
    `VALIDATION REQUEST for PRD ${prdSlug} — this is a request to validate, NOT a completion notice.`,
    pathLine,
    `The scheduler job self-reported outcome "${outcome}". Treat that strictly as an UNVERIFIED CLAIM — it carries no authority about whether the work actually landed.`,
    '',
    'Do the following, independently:',
    `1. Read the PRD's own "Acceptance criteria" section from the file above.`,
    '2. Check EACH criterion against the actual working tree (read the real files, run the real commands).',
    '3. Run `git diff --stat` over the run window (and `git log --stat` for commits landed during the run). An empty diff on an implementation PRD means the work did not land — treat that as REFUTED.',
    '',
    'WARNING — the failure mode this validation exists to catch: an exit code of 0, a green queue row, or a confident completion report are NOT evidence that anything shipped. Only the working tree is evidence. (A prior PRD reported "completed" having made zero edits.)',
    '',
    'Reply with exactly one verdict word, VERIFIED or REFUTED, followed by per-criterion evidence: for each acceptance criterion cite file:line or paste the command output that proves or disproves it.',
  ].join('\n');
}

/**
 * maybeEnqueueValidationPrompt(args, deps) → { enqueued: boolean, reason?: string }
 *
 * Called by scheduler.cjs's notifyOriginatingTab immediately after a
 * SUCCESSFUL appendResponseEventIfKnown for a terminal (completed/failed)
 * PRD outcome. Fire-and-forget: never throws; every refusal returns a
 * reason so tests (and log lines) can tell the gates apart.
 *
 * Guards, in order (all four AC gates):
 *   1. SM_EPIC_VALIDATION_DISABLE=1 kill-switch → skip.
 *   2. LOOP GUARD — how the guard distinguishes a check-in from a
 *      validation result: a scheduler check-in event is born with
 *      `validation: 'unvalidated'` (stamped by appendResponseEventIfKnown's
 *      meta), while a validation RESULT event carries 'validating' /
 *      'verified' / 'refuted' (and a plain chat response carries no
 *      validation field at all). Only `eventValidation === 'unvalidated'`
 *      may trigger a prompt, so an appended validation result can never
 *      enqueue a further prompt — no loop.
 *   3. Epic must exist AND have status 'active' in the on-disk
 *      active-index.json (re-checked here even though the append already
 *      enforced it, so the gate holds for any future call site too).
 *   4. Once per (epicId, prdSlug): in-memory `_fired` Set for the common
 *      path, plus a durable re-check of the Epic's own event chain — the
 *      check-in event just appended for this pair accounts for ONE
 *      validation-stamped response event with this prdSlug; two or more
 *      means an earlier check-in already requested validation (e.g. a
 *      re-notify after an app restart emptied `_fired`), so skip.
 *
 * (Gate: slot pool — see the module doc comment; no spawn happens here.)
 *
 * Complexity: O(n) over the Epic's event chain for the durable dedup scan.
 */
function maybeEnqueueValidationPrompt(
  { cwd, epicId, prdSlug, prdPath = null, outcome, eventValidation },
  { sendPrompt, readActiveIndex = defaultReadActiveIndex, log = console } = {},
) {
  try {
    // Gate 1: kill-switch (SM_EPIC_VALIDATION_DISABLE, per SM_DOD_DISABLE precedent).
    if (process.env.SM_EPIC_VALIDATION_DISABLE === '1') return { enqueued: false, reason: 'disabled' };

    // Gate 2: LOOP GUARD (see doc comment above for how the field value
    // distinguishes a check-in from a validation result).
    if (eventValidation !== 'unvalidated') return { enqueued: false, reason: 'not-a-checkin' };

    if (!cwd || !epicId || !prdSlug || typeof sendPrompt !== 'function') {
      return { enqueued: false, reason: 'missing-args' };
    }

    // Gate 4a: in-memory once-per-pair (checked before the disk read — cheap first).
    const key = pairKey(epicId, prdSlug);
    if (_fired.has(key)) return { enqueued: false, reason: 'already-fired' };

    // Gate 3: authoring Epic must be a known, still-active session.
    const index = readActiveIndex(cwd);
    const session = index && index.sessions && index.sessions[epicId];
    if (!session || session.status !== 'active') {
      return { enqueued: false, reason: 'epic-not-active' };
    }

    // Gate 4b: durable once-per-pair — the just-appended check-in accounts
    // for one validation-stamped response event for this prdSlug; a second
    // one means a previous check-in already asked.
    const events = (index.events && index.events[epicId]) || [];
    const priorCheckins = events.filter(
      (e) => e && e.kind === 'response' && e.prdSlug === prdSlug && e.validation !== undefined,
    );
    if (priorCheckins.length >= 2) {
      _fired.add(key); // remember so later re-notifies skip the disk read too
      return { enqueued: false, reason: 'already-fired-durable' };
    }

    const prompt = buildValidationPrompt({ prdSlug, prdPath, outcome });
    sendPrompt(epicId, prompt);
    _fired.add(key);
    return { enqueued: true };
  } catch (e) {
    try { (log || console).error('[epicValidationHook] enqueue error', prdSlug, e); } catch { /* noop */ }
    return { enqueued: false, reason: 'error' };
  }
}

/** Test hook: clear the once-per-pair memory. */
function __resetForTests() {
  _fired.clear();
}

module.exports = {
  buildValidationPrompt,
  maybeEnqueueValidationPrompt,
  __resetForTests,
};
