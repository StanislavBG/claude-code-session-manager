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
  const file = activeIndexPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, file);
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
 * ensureEpic(cwd, { goalText, tag?, reuseByGoal? }) → Promise<{ epicId, prdDir, created }>
 *
 * Mints a new Epic — or, with `reuseByGoal`, joins the existing ACTIVE Epic
 * whose goalText matches (used by the recurring feedback sweep so successive
 * sweeps chain into one Epic instead of minting one per tick).
 *
 * The Epic's id doubles as its directory name under scheduler/epics/, so the
 * PromptSession ↔ on-disk Epic mapping is 1:1 with no lookup table.
 */
function ensureEpic(cwd, { goalText, tag, reuseByGoal = false, epicId: explicitEpicId } = {}) {
  if (!cwd || typeof cwd !== 'string') throw new Error('ensureEpic: cwd is required');
  return withPathLock(activeIndexPath(cwd), () => {
    const index = readActiveIndex(cwd);

    // A dispatch that already knows its Epic (sourcePromptId frontmatter from
    // an Epic-conversation dispatch) joins it rather than minting a sibling.
    if (explicitEpicId && index.sessions[explicitEpicId]) {
      const prdDir = resolveEpicPrdWriteDir(cwd, explicitEpicId);
      fs.mkdirSync(prdDir, { recursive: true });
      return { epicId: explicitEpicId, prdDir, created: false };
    }

    if (reuseByGoal) {
      for (const s of Object.values(index.sessions)) {
        if (s && s.status === 'active' && s.goalText === goalText) {
          const prdDir = resolveEpicPrdWriteDir(cwd, s.id);
          fs.mkdirSync(prdDir, { recursive: true });
          return { epicId: s.id, prdDir, created: false };
        }
      }
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
      status: 'active',
      createdAt: now,
      completedAt: null,
      ...(tag ? { tag } : {}),
    };
    const firstEvent = {
      id: crypto.randomUUID(),
      promptSessionId: epicId,
      kind: 'prompt',
      causedByEventId: null,
      at: now,
      text: String(goalText || ''),
    };
    index.sessions[epicId] = session;
    index.events[epicId] = [firstEvent];
    writeActiveIndex(cwd, index);

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
    if (!index.sessions[epicId]) return false;
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
  if (!index.sessions[epicId]) return false;
  delete index.sessions[epicId];
  delete index.events[epicId];
  writeActiveIndex(cwd, index);
  return true;
}

module.exports = { ensureEpic, appendPrdCreatedEvent, removeEpic, activeIndexPath, readActiveIndex };
