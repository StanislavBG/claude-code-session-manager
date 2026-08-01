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

function activeIndexPath(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
}

function readActiveIndex(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeIndexPath(cwd), 'utf8'));
    return {
      sessions: parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {},
      events: parsed && typeof parsed.events === 'object' && parsed.events ? parsed.events : {},
    };
  } catch {
    return { sessions: {}, events: {} };
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
 * ensureEpic(cwd, { goalText, tag?, reuseByGoal?, status?, mintIfMissing? }) → Promise<{ epicId, prdDir, created }>
 *
 * `status` defaults to 'proposed' — a fail-safe default so any caller that
 * forgets to pass it files an Epic that waits for human approval rather than
 * one that starts running immediately. Pass 'active' explicitly only for the
 * one legitimate immediate-start path (the New Epic UI's own proposed→active
 * transition, `promptSessions.ts`'s `approveProposed`).
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
function ensureEpic(cwd, { goalText, tag, reuseByGoal = false, epicId: explicitEpicId, status = 'proposed', openingPrompt = null, mintIfMissing = true } = {}) {
  if (!cwd || typeof cwd !== 'string') throw new Error('ensureEpic: cwd is required');
  return withPathLock(activeIndexPath(cwd), () => {
    const index = readActiveIndex(cwd);

    // A dispatch that already knows its Epic (sourcePromptId frontmatter from
    // an Epic-conversation dispatch) joins it rather than minting a sibling.
    if (explicitEpicId && hasOwn(index.sessions, explicitEpicId)) {
      const prdDir = resolveEpicPrdWriteDir(cwd, explicitEpicId);
      fs.mkdirSync(prdDir, { recursive: true });
      return { epicId: explicitEpicId, prdDir, created: false };
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
      throw new Error(
        `ensureEpic: no existing Epic found (epicId=${explicitEpicId ?? 'none'}) and mintIfMissing is false — `
        + 'a new Epic can only be created by explicit human intent (New Epic UI, or /propose-epic + Approve & start), '
        + 'never implicitly by a PRD-authoring path',
      );
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
    };
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
    appendAuditEvent('epic_mint', { cwd, epicId, status, tag: tag ?? null, goalText: session.goalText });

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
  const index = readActiveIndex(cwd);
  if (!hasOwn(index.sessions, epicId)) return false;
  delete index.sessions[epicId];
  delete index.events[epicId];
  writeActiveIndex(cwd, index);
  return true;
}

module.exports = { ensureEpic, appendPrdCreatedEvent, removeEpic, activeIndexPath, readActiveIndex };
