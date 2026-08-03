/**
 * epicMint.cjs — auto-mint an Epic (PromptSession) for a PRD dispatch.
 *
 * Domain rule (CLAUDE.md "Domain model"): every PRD belongs to an Epic; the
 * hierarchy TAB → operations-root → EPIC → PRD is total. Dispatch paths that
 * have no Epic in hand (feedback sweep, ad-hoc /develop, admin/MCP create)
 * call ensureEpic() to create-or-join one instead of writing epicless PRDs.
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
// mintIfMissing:false join-only check that PRD-authoring paths rely on).
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

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'of', 'to', 'for', 'and', 'in', 'on', 'at', 'this', 'that',
]);

// Lowercase, strip punctuation, split on whitespace, drop stopwords — shared
// by findJoinableEpic's similarity check. Kept standalone so its behavior is
// independently testable rather than inlined into the Jaccard computation.
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token));
}

function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const JOIN_SIMILARITY_THRESHOLD = 0.35;

/**
 * findJoinableEpicInIndex(index, { goalText, preferEpicId, status }) → { epicId, matchedBy, score? } | null
 *
 * Same contract as findJoinableEpic() but takes an already-loaded index —
 * lets ensureEpic() consult this without a second readActiveIndex() call
 * inside its own withPathLock critical section. Two strategies, in order:
 *  1. `preferEpicId` — an explicitly-known origin Epic the caller already has
 *     in hand. Joined immediately (no similarity check) as long as it exists
 *     and is still open ('proposed' or 'active') — a 'completed' or unknown
 *     preferEpicId falls through to strategy 2 rather than joining a dead Epic.
 *  2. Keyword-similarity — Jaccard token-set overlap between `goalText` and
 *     every other OPEN Epic's goalText in the same cwd (open = 'proposed' or
 *     'active', regardless of the specific requested `status` — a proposed
 *     RCA report and an active one about the same topic are still the same
 *     underlying issue). Highest score wins if it clears
 *     JOIN_SIMILARITY_THRESHOLD; otherwise no join. `status` is accepted for
 *     signature symmetry with ensureEpic()/reuseByGoal but only participates
 *     in strategy 1's preferEpicId open-check, not the similarity filter.
 */
function findJoinableEpicInIndex(index, { goalText, preferEpicId = null, status: _status = 'proposed' } = {}) {
  if (preferEpicId && hasOwn(index.sessions, preferEpicId)) {
    const preferred = index.sessions[preferEpicId];
    if (preferred && (preferred.status === 'proposed' || preferred.status === 'active')) {
      return { epicId: preferEpicId, matchedBy: 'preferEpicId' };
    }
  }

  const candidateTokens = tokenize(goalText);
  let best = null;
  for (const s of Object.values(index.sessions)) {
    if (!s || (s.status !== 'proposed' && s.status !== 'active')) continue;
    const score = jaccardSimilarity(candidateTokens, tokenize(s.goalText));
    if (score >= JOIN_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { epicId: s.id, matchedBy: 'similarity', score };
    }
  }
  return best;
}

/**
 * findJoinableEpic(cwd, { goalText, preferEpicId, status }) → { epicId, matchedBy, score? } | null
 *
 * Public entry point for callers outside ensureEpic()'s own critical section
 * (tests, future PRD 899/900 wiring) — loads the index itself. See
 * findJoinableEpicInIndex() for the matching logic.
 */
function findJoinableEpic(cwd, opts = {}) {
  return findJoinableEpicInIndex(readActiveIndex(cwd), opts);
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
 * ensureEpic(cwd, { goalText, tag?, reuseByGoal?, status?, openingPrompt?, mintIfMissing?, source?, forceNewEpic?, agentType? }) → Promise<{ epicId, prdDir, created }>
 *
 * Before minting brand-new, the mint branch consults findJoinableEpic() —
 * minting is the LAST resort, not the default, for automated callers. Pass
 * `forceNewEpic: true` to skip that check and always mint (the one
 * legitimate case being explicit human-authored creation).
 *
 * `status` defaults to 'proposed' — a fail-safe default so any caller that
 * forgets to pass it files an Epic that waits for human approval rather than
 * one that starts running immediately. Every Epic is BORN 'proposed' — the
 * mint branch below ignores/rejects any other requested status; it is
 * fail-closed, mirroring opsOwnership.cjs's assertOpsWrite. Activation
 * ('proposed' → 'active') happens exactly once, entirely in the renderer
 * store's `approveProposed` (`state/promptSessions.ts`) — that code path
 * never calls ensureEpic(). Joining an already-'active' Epic (this function's
 * join branches, above the mint branch) remains legal and unchanged.
 *
 * `mintIfMissing` defaults to true for the small set of callers that are
 * themselves the human-intent gate (propose-epic, the RCA hook, the feedback
 * sweep — all of which pass `status: 'proposed'`, so "minting" here still
 * never starts anything without a human's Approve & start). Callers that are
 * NOT themselves a human-intent gate (an automated PRD-write path acting on
 * a session's behalf) must pass `mintIfMissing: false` — that path may only
 * JOIN an Epic that already exists; it throws instead of silently creating a
 * new one, so no PRD-authoring surface can conjure Epics on its own.
 *
 * Mints a new Epic — or, with `reuseByGoal`, joins the existing Epic (of the
 * same `status`) whose goalText matches (used by the recurring feedback sweep
 * so successive sweeps chain into one Epic instead of minting one per tick).
 *
 * The Epic's id doubles as its directory name under scheduler/epics/, so the
 * PromptSession ↔ on-disk Epic mapping is 1:1 with no lookup table.
 */
function ensureEpic(cwd, { goalText, tag, reuseByGoal = false, epicId: explicitEpicId, status = 'proposed', openingPrompt = null, mintIfMissing = true, source = null, forceNewEpic = false, agentType = null } = {}) {
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
    // really another Epic's prompt" cross-contamination bug. Mirrors
    // findJoinableEpicInIndex()'s preferEpicId open-check (line ~124).
    if (explicitEpicId && hasOwn(index.sessions, explicitEpicId)) {
      const preferred = index.sessions[explicitEpicId];
      if (preferred && (preferred.status === 'proposed' || preferred.status === 'active')) {
        const prdDir = resolveEpicPrdWriteDir(cwd, explicitEpicId);
        fs.mkdirSync(prdDir, { recursive: true });
        return { epicId: explicitEpicId, prdDir, created: false };
      }
      console.warn(`[epicMint] ensureEpic: explicit epicId ${explicitEpicId} exists but is not open (status=${preferred?.status ?? 'unknown'}) — refusing to join, falling through`);
      appendAuditEvent('epic_mint_refused', {
        cwd,
        epicId: explicitEpicId,
        status,
        reason: `explicit epicId exists but is not open (status=${preferred?.status ?? 'unknown'}) — refusing to join, falling through to mint`,
      });
    }

    if (reuseByGoal) {
      for (const s of Object.values(index.sessions)) {
        // Match the status being requested so repeat proposals chain into
        // one proposal instead of spawning a duplicate per trigger.
        if (s && s.status === status && s.goalText === goalText) {
          // A PROPOSED Epic has not started, so its opening prompt is still
          // mutable: a re-trigger carrying richer detail (e.g. the RCA hook's
          // later investigation pass) enriches the pending proposal in place
          // rather than filing a duplicate. Never done for an active Epic —
          // its first turn is already history.
          if (s.status === 'proposed' && openingPrompt && openingPrompt !== s.openingPrompt) {
            s.openingPrompt = String(openingPrompt);
            const chain = index.events[s.id];
            if (Array.isArray(chain) && chain[0] && chain[0].kind === 'prompt') {
              chain[0].text = String(openingPrompt);
            }
            writeActiveIndex(cwd, index);
          }
          const prdDir = resolveEpicPrdWriteDir(cwd, s.id);
          fs.mkdirSync(prdDir, { recursive: true });
          return { epicId: s.id, prdDir, created: false };
        }
      }
    }

    if (!mintIfMissing) {
      const reason = 'no existing Epic found and mintIfMissing is false — a new Epic can only be created by '
        + 'explicit human intent (New Epic UI, or /propose-epic + Approve & start), never implicitly by a '
        + 'PRD-authoring path';
      appendAuditEvent('epic_mint_refused', { cwd, epicId: explicitEpicId ?? null, status, reason });
      throw new Error(`ensureEpic: ${reason} (epicId=${explicitEpicId ?? 'none'})`);
    }

    if (!forceNewEpic) {
      const joinable = findJoinableEpicInIndex(index, { goalText, preferEpicId: explicitEpicId, status });
      if (joinable) {
        const prdDir = resolveEpicPrdWriteDir(cwd, joinable.epicId);
        fs.mkdirSync(prdDir, { recursive: true });
        return { epicId: joinable.epicId, prdDir, created: false };
      }
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
      // 'proposed' files the Epic WITHOUT starting it — nothing runs until a
      // human approves it in the Epics workspace. This is the sink that
      // replaced the feedback-folder intake (see lib/rcaFeedbackHook.cjs).
      status,
      createdAt: now,
      completedAt: null,
      ...(tag ? { tag } : {}),
      // Full body for a proposal whose goalText is only a one-line title;
      // sent verbatim as the first prompt when a human approves it.
      ...(openingPrompt ? { openingPrompt: String(openingPrompt) } : {}),
      // Structured trace of which automated producer minted this Epic — see
      // EpicSource in state/promptSessions.ts.
      ...(source ? { source } : {}),
      // Display-only "who is working" persona name (New Epic card's Agent
      // picker) — mirrors the renderer's own buildPromptSession
      // (state/promptSessions.ts). Never affects which claude CLI spawns.
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

    // Every mint is logged, whether the Epic starts 'proposed' (human gate
    // ahead) or 'active' (started immediately) — this is the trace-back point
    // for "who/what created this Epic" (see auditLog.cjs).
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
  appendPrdCreatedEvent,
  removeEpic,
  activeIndexPath,
  readActiveIndex,
  findJoinableEpic,
  tokenize,
  // Exported so lib/activeIndexMerge.cjs's renderer-facing merge IPC handler
  // serializes through the SAME lock instance as ensureEpic/
  // appendPrdCreatedEvent (module-level Map, shared via Node's require
  // cache) — one lock per active-index.json path across both callers, not
  // two independent lock maps that could still interleave.
  withPathLock,
};
