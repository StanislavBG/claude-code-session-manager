/**
 * epicMint.cjs — resolve the Epic (PromptSession) a PRD dispatch belongs to,
 * and mint the one Epic-creation path there is.
 *
 * Domain rule (CLAUDE.md "Domain model"): every PRD belongs to an Epic; the
 * hierarchy TAB → operations-root → EPIC → PRD is total. Dispatch paths call
 * ensureEpic() to JOIN the Epic they already belong to instead of writing
 * epicless PRDs — they can never create one.
 *
 * SINGLE-CREATOR LAW (fail-closed, mirrors opsOwnership.cjs's assertOpsWrite):
 * an Epic comes into existence in exactly ONE place — the human pressing
 * "New Epic" in the app. That is the only caller allowed to pass
 * `mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI` (today: lib/
 * promptSessionsCreateEpic.cjs, the New Epic card's IPC handler). Every other
 * caller is join-only and throws rather than conjuring an Epic. Agents that
 * are sure work is needed run /develop inside the Epic they are already in;
 * agents that are not sure say so and let the human open an Epic.
 *
 * The Epic registry is the renderer's own store: the per-cwd
 * `session-manager-operations/prompt-sessions/active-index.json`
 * ({ sessions, events } — shape defined in state/promptSessions.ts). Writing
 * the same file the renderer reads keeps a single source of truth: an
 * auto-minted Epic shows up in the Epics nav like a hand-created one.
 *
 * Plain Node module (no Electron deps) so the external watchdog scripts can
 * require it. Atomic writes: tmp + rename, same pattern as config.cjs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveEpicPrdWriteDir } = require('./prdLocations.cjs');
const { assertOpsWrite } = require('./opsOwnership.cjs');
const { appendAuditEvent } = require('./auditLog.cjs');
// Required as the module object (not destructured) so a test can
// monkeypatch promptSessionSchema.assertValidPromptSession in place to
// simulate a corrupted construction — the real construction below is
// hardcoded and always valid.
const promptSessionSchema = require('./promptSessionSchema.cjs');

// The one token that unlocks ensureEpic's mint branch. Held by
// lib/promptSessionsCreateEpic.cjs (the New Epic card's IPC handler) and
// nothing else — grep for it before adding a second holder, that is a
// deliberate domain-model change, not a convenience.
const MINT_AUTHORITY_NEW_EPIC_UI = 'new-epic-ui';

// The SECOND (and only other) mint authority — a deliberate domain-model
// change, argued for here rather than discovered later.
//
// PROJECT-TO-PROJECT FEEDBACK. With `/process-feedback`, `/my-feedback` and
// the `feedback/` folder retired (2026-08-02) and the scheduler correctly
// locked down to join-only, an agent working in Project-A had NO way to hand
// a finding to Project-B — the finding either died in a transcript or the
// human had to relay it by hand. `lib/crossProjectFeedback.cjs` restores that
// conduit, and it is the sole holder of this token.
//
// What makes it safe is the part of the SINGLE-CREATOR LAW that actually
// guards spend: every Epic is born 'proposed', and NOTHING runs until a human
// in the RECEIVING project presses "Approve & start". This authority cannot
// change that — the BORN-PROPOSED check below still applies to it verbatim,
// and `crossProjectFeedback.cjs` additionally pins tag/source before minting.
// So this is not a re-opening of the agent-facing proposal channel that was
// removed: an agent may deposit a proposal into another project's inbox, and
// that is all it may do. The removed channel let an agent file work into the
// project it was already running in, which is what /develop-inside-your-own-
// Epic replaced and which stays refused.
const MINT_AUTHORITY_CROSS_PROJECT_FEEDBACK = 'cross-project-feedback';

const MINT_AUTHORITIES = Object.freeze([
  MINT_AUTHORITY_NEW_EPIC_UI,
  MINT_AUTHORITY_CROSS_PROJECT_FEEDBACK,
]);

function activeIndexPath(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
}

function readActiveIndex(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeIndexPath(cwd), 'utf8'));
    return {
      sessions: parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {},
      events: parsed && typeof parsed.events === 'object' && parsed.events ? parsed.events : {},
      // Passed through untouched — this module never consults tombstones (it
      // doesn't resurrect completed/deleted Epics on its own), but every
      // caller here does read-modify-write on the object this returns, so
      // dropping the field would silently erase the removal tombstones
      // lib/activeIndexMerge.cjs's mergeActiveIndex records the next time any
      // of ensureEpic/appendPrdCreatedEvent/removeEpic writes this file.
      tombstones: parsed && typeof parsed.tombstones === 'object' && parsed.tombstones ? parsed.tombstones : {},
    };
  } catch {
    return { sessions: {}, events: {}, tombstones: {} };
  }
}

function writeActiveIndex(cwd, index) {
  // Single-writer law: prompt-sessions/ is owned by 'epics'; the scheduler
  // holds a narrow delegation for active-index.json only (opsOwnership.cjs).
  assertOpsWrite(activeIndexPath(cwd), 'scheduler');
  const file = activeIndexPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, file);
}

// index.sessions/index.events are plain objects parsed from JSON — bracket
// lookup with an attacker/agent-supplied key like "__proto__" or
// "constructor" resolves through the prototype chain to a truthy
// Object.prototype member even though no such Epic was ever written,
// bypassing every "does this Epic exist" gate below (including the
// join-only existence check that PRD-authoring paths rely on).
// Always use this instead of `obj[key]`/`!obj[key]` for existence checks.
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function slugify(text) {
  return String(text || 'epic')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'epic';
}

// Serializes read-modify-write cycles per active-index.json path, mirroring
// promptSessionEvents.cjs's own pendingWritesByPath/withPathLock. The current
// read/write pair below is synchronous (fs.readFileSync/writeFileSync), so
// there is no await between them today and no real interleaving is possible
// — but wrapping every read-modify-write in the same lock the sibling module
// uses means the two files no longer diverge on this pattern, and the lock
// is already in place if either function's I/O ever becomes async.
const pendingWritesByPath = new Map();

function withPathLock(lockPath, task) {
  const prior = pendingWritesByPath.get(lockPath) || Promise.resolve();
  const settle = () => task();
  const run = prior.then(settle, settle);
  pendingWritesByPath.set(
    lockPath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * ensureEpic(cwd, { epicId?, goalText, tag?, status?, openingPrompt?, source?, agentType?, mintAuthority? }) → Promise<{ epicId, prdDir, created }>
 *
 * Two behaviors, and only two:
 *  - JOIN (the default, for every automated caller): `epicId` names an Epic
 *    that already exists and is still open ('proposed'/'active') → its prds/
 *    directory is returned with `created: false`. Anything else throws.
 *  - MINT (the New Epic UI alone): `mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI`
 *    creates a brand-new Epic. No similarity/keyword matching runs first — the
 *    human asked for a new Epic, so they get a new Epic.
 *
 * Every Epic is BORN 'proposed'; `status` defaults to it and the mint branch
 * rejects any other value outright (fail-closed, mirroring opsOwnership.cjs's
 * assertOpsWrite). Activation ('proposed' → 'active') happens exactly once, in
 * the renderer store's `approveProposed` (`state/promptSessions.ts`) — a path
 * that never calls ensureEpic().
 *
 * The Epic's id doubles as its directory name under scheduler/epics/, so the
 * PromptSession ↔ on-disk Epic mapping is 1:1 with no lookup table.
 */
function ensureEpic(cwd, { goalText, tag, epicId: explicitEpicId, status = 'proposed', openingPrompt = null, sections = null, source = null, agentType = null, mintAuthority = null } = {}) {
  if (!cwd || typeof cwd !== 'string') throw new Error('ensureEpic: cwd is required');
  // A relative cwd (e.g. a caller passing '.') would otherwise get stored
  // verbatim on the minted Epic's `cwd` field — the renderer's EpicsWorkspace
  // matches Epics to a tab by exact `s.cwd === effectiveCwd` string equality
  // against the tab's absolute path, so a relative value silently produces an
  // Epic that exists on disk but never renders in any project's queue.
  cwd = path.resolve(cwd);
  return withPathLock(activeIndexPath(cwd), () => {
    const index = readActiveIndex(cwd);

    // A dispatch that already knows its Epic (sourcePromptId frontmatter from
    // an Epic-conversation dispatch) joins it rather than minting a sibling —
    // but only while that Epic is still open. Joining unconditionally here
    // let a stale/hallucinated sourcePromptId silently attach a PRD (and its
    // follow-on events/chat activity) to an unrelated or even completed
    // Epic — the "this session ran again without my knowledge, and it was
    // really another Epic's prompt" cross-contamination bug.
    if (explicitEpicId && hasOwn(index.sessions, explicitEpicId)) {
      const preferred = index.sessions[explicitEpicId];
      if (preferred && (preferred.status === 'proposed' || preferred.status === 'active')) {
        const prdDir = resolveEpicPrdWriteDir(cwd, explicitEpicId);
        fs.mkdirSync(prdDir, { recursive: true });
        return { epicId: explicitEpicId, prdDir, created: false };
      }
      console.warn(`[epicMint] ensureEpic: explicit epicId ${explicitEpicId} exists but is not open (status=${preferred?.status ?? 'unknown'}) — refusing to join`);
      appendAuditEvent('epic_mint_refused', {
        cwd,
        epicId: explicitEpicId,
        status,
        reason: `explicit epicId exists but is not open (status=${preferred?.status ?? 'unknown'}) — refusing to join`,
      });
    }

    // SINGLE-CREATOR LAW (see this file's header). Only the New Epic UI —
    // or, for an inbound cross-project feedback proposal, lib/
    // crossProjectFeedback.cjs — may mint; every other caller reaching this
    // line was trying to JOIN an Epic that isn't there, which is a bug in the
    // caller, not a cue to create one.
    if (!MINT_AUTHORITIES.includes(mintAuthority)) {
      const reason = 'no open Epic to join — an Epic is created in exactly two places, the New Epic UI and an '
        + 'inbound cross-project feedback proposal (mintAuthority). Agents that are sure the work is needed run '
        + '/develop inside the Epic they are already in; a PRD-authoring path may never conjure one';
      appendAuditEvent('epic_mint_refused', { cwd, epicId: explicitEpicId ?? null, status, reason });
      throw new Error(`ensureEpic: ${reason} (epicId=${explicitEpicId ?? 'none'})`);
    }

    // BORN-PROPOSED LAW (fail-closed, mirrors opsOwnership.cjs's
    // assertOpsWrite): a mint always writes 'proposed', regardless of what
    // status the caller requested. A caller explicitly asking to mint
    // 'active' is refused outright rather than silently downgraded — that
    // shape (mint + already-active) should never occur, so it is treated as
    // a bug in the caller, not a normal fallback path.
    if (status !== 'proposed') {
      const reason = `ensureEpic: refusing to mint a new Epic with status '${status}' — every Epic is born `
        + "'proposed' (CLAUDE.md domain model); activation happens only via the renderer store's "
        + 'approveProposed, never through ensureEpic()';
      appendAuditEvent('epic_mint_refused', { cwd, epicId: explicitEpicId ?? null, status, reason });
      throw new Error(reason);
    }

    const epicId = `${slugify(goalText)}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const session = {
      id: epicId,
      cwd,
      goalText: String(goalText || ''),
      // Independently minted, never shared with a SessionTab — same invariant
      // as renderer-created PromptSessions (state/promptSessions.ts).
      claudeSessionId: crypto.randomUUID(),
      // 'proposed' files the Epic WITHOUT starting it — nothing runs until the
      // human presses Approve & start in the Epics workspace.
      status,
      createdAt: now,
      completedAt: null,
      ...(tag ? { tag } : {}),
      // Full body for a proposal whose goalText is only a one-line title;
      // sent verbatim as the first prompt when a human approves it.
      ...(openingPrompt ? { openingPrompt: String(openingPrompt) } : {}),
      // Structured slices of the same openingPrompt (composeEpicIntake's
      // EpicIntakeSection[]) — carried alongside it so the Epic's first turn
      // can render an AIM briefing card instead of re-parsing the flat
      // string. Absent whenever openingPrompt is absent too.
      ...(Array.isArray(sections) && sections.length ? { sections } : {}),
      // Structured trace of which surface minted this Epic — see EpicSource in
      // state/promptSessions.ts.
      ...(source ? { source } : {}),
      // Display-only "who is working" persona name (New Epic card's Agent
      // picker). The renderer no longer constructs a PromptSession itself —
      // PRD 955 / commit ba54269 routed createPromptSession through this same
      // ensureEpic IPC path (state/promptSessions.ts). Never affects which
      // claude CLI spawns.
      ...(agentType ? { agentType } : {}),
    };

    // Validate the constructed record against the canonical PromptSession
    // schema (promptSessionSchema.cjs) before it ever reaches disk — closes
    // the drift risk between this hand-constructed literal and the
    // renderer's own createPromptSession, same fail-closed spirit as the
    // BORN-PROPOSED LAW check above.
    try {
      promptSessionSchema.assertValidPromptSession(session);
    } catch (err) {
      appendAuditEvent('epic_mint_refused', {
        cwd,
        epicId,
        status,
        reason: `constructed session object failed PromptSession schema validation: ${err.message}`,
      });
      throw err;
    }

    const firstEvent = {
      id: crypto.randomUUID(),
      promptSessionId: epicId,
      kind: 'prompt',
      causedByEventId: null,
      at: now,
      text: String(openingPrompt || goalText || ''),
    };
    index.sessions[epicId] = session;
    index.events[epicId] = [firstEvent];
    writeActiveIndex(cwd, index);

    // Every mint is logged — the trace-back point for "who created this Epic"
    // (see auditLog.cjs).
    appendAuditEvent('epic_mint', { cwd, epicId, status, tag: tag ?? null, goalText: session.goalText, source: source ?? null });

    const prdDir = resolveEpicPrdWriteDir(cwd, epicId);
    fs.mkdirSync(prdDir, { recursive: true });
    return { epicId, prdDir, created: true };
  });
}

/**
 * appendPrdCreatedEvent(cwd, epicId, prdSlug) — record a PRD dispatch on the
 * Epic's event chain, FK-linked to the current tail (chain, not tree — the
 * referential-integrity requirement from promptSessions.ts). Returns a
 * Promise<boolean>.
 */
function appendPrdCreatedEvent(cwd, epicId, prdSlug, text) {
  return withPathLock(activeIndexPath(cwd), () => {
    const index = readActiveIndex(cwd);
    if (!hasOwn(index.sessions, epicId)) return false;
    const chain = Array.isArray(index.events[epicId]) ? index.events[epicId] : [];
    const tail = chain.length ? chain[chain.length - 1] : null;
    chain.push({
      id: crypto.randomUUID(),
      promptSessionId: epicId,
      kind: 'prd_created',
      causedByEventId: tail ? tail.id : null,
      at: new Date().toISOString(),
      prdSlug,
      ...(text ? { text } : {}),
    });
    index.events[epicId] = chain;
    writeActiveIndex(cwd, index);
    return true;
  });
}

/**
 * removeEpic(cwd, epicId) — roll back a freshly-minted Epic when the caller
 * that minted it (ensureEpic's `created: true`) failed to complete its work
 * (e.g. the PRD write that motivated the mint never landed). Deletes the
 * Epic's entry from both active-index.json maps. Never call this for an
 * Epic ensureEpic reported as joined (`created: false`) — that Epic predates
 * this call and may carry unrelated history.
 */
function removeEpic(cwd, epicId) {
  if (!cwd || !epicId) return false;
  return withPathLock(activeIndexPath(cwd), () => {
    const index = readActiveIndex(cwd);
    if (!hasOwn(index.sessions, epicId)) return false;
    delete index.sessions[epicId];
    delete index.events[epicId];
    writeActiveIndex(cwd, index);
    return true;
  });
}

module.exports = {
  ensureEpic,
  MINT_AUTHORITY_NEW_EPIC_UI,
  MINT_AUTHORITY_CROSS_PROJECT_FEEDBACK,
  MINT_AUTHORITIES,
  appendPrdCreatedEvent,
  removeEpic,
  activeIndexPath,
  readActiveIndex,
  // Exported so lib/activeIndexMerge.cjs's renderer-facing merge IPC handler
  // serializes through the SAME lock instance as ensureEpic/
  // appendPrdCreatedEvent (module-level Map, shared via Node's require
  // cache) — one lock per active-index.json path across both callers, not
  // two independent lock maps that could still interleave.
  withPathLock,
};
