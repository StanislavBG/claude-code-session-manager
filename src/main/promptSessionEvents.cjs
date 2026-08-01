'use strict';

/**
 * Main-process counterpart to promptSessions.ts's event chain, used ONLY by
 * the scheduler's PRD-finished notification path (notifyOriginatingTab,
 * scheduler.cjs). The renderer owns the live in-memory PromptSession store
 * and its own persistActiveIndex; this module never touches that store — it
 * reads/writes the SAME on-disk active-index.json directly, read-modify-
 * write, so a scheduler job (which runs in the main process, with no
 * renderer store to append to) can chain a 'response' event onto a known
 * session's tail without routing a synthetic prompt into an unrelated tab
 * (PRD 814).
 */

const config = require('./config.cjs');

function promptSessionActiveIndexPath(cwd) {
  return `${String(cwd).replace(/\/+$/, '')}/session-manager-operations/prompt-sessions/active-index.json`;
}

// IPC channel broadcast whenever an event is appended to a PromptSession's
// chain from the main process (currently only the scheduler's response-event
// append below). Mirrors chatRunner.cjs's attachWindow/broadcast pattern.
const EVENT_APPENDED_CHANNEL = 'promptSession:event-appended';

let mainWindow = null;
function attachWindow(win) { mainWindow = win; }

function broadcast(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch { /* render frame may be gone */ }
}

let seq = 0;
function mintEventId() {
  seq += 1;
  return `pevt-${Date.now().toString(36)}-${seq}`;
}

// Serializes read-modify-write cycles per active-index.json path so two
// PRDs finishing back-to-back for sessions in the same cwd chain onto the
// tail in issue order instead of racing two independent read-then-write
// round trips (mirrors promptSessions.ts's own pendingWritesByPath).
const pendingWritesByPath = new Map();

function withPathLock(path, task) {
  const prior = pendingWritesByPath.get(path) || Promise.resolve();
  const settle = () => task();
  const run = prior.then(settle, settle);
  pendingWritesByPath.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * If `sourcePromptId` resolves to a known, still-active PromptSession under
 * `cwd`'s active-index.json, appends a 'response' event chained to that
 * session's current tail and returns true. Returns false (never throws) for
 * every case the caller must fall back on: missing cwd/id, no index file,
 * unknown id, a completed session, an empty event chain, or any I/O error —
 * so notifyOriginatingTab's existing tab-external-ticket path stays the
 * safety net, not a special case.
 */
async function appendResponseEventIfKnown(cwd, sourcePromptId, text) {
  if (!cwd || !sourcePromptId) return false;
  const path = promptSessionActiveIndexPath(cwd);
  try {
    return await withPathLock(path, async () => {
      const result = await config.readJson(path);
      if (!result.exists || !result.data) return false;
      const data = result.data;
      const session = data.sessions && data.sessions[sourcePromptId];
      if (!session || session.status !== 'active') return false;
      const events = (data.events && data.events[sourcePromptId]) || [];
      const tail = events.length > 0 ? events[events.length - 1] : null;
      if (!tail) return false;
      const event = {
        id: mintEventId(),
        promptSessionId: sourcePromptId,
        kind: 'response',
        causedByEventId: tail.id,
        at: new Date().toISOString(),
        text,
      };
      data.events[sourcePromptId] = [...events, event];
      await config.writeJson(path, data);
      broadcast(EVENT_APPENDED_CHANNEL, { cwd, promptSessionId: sourcePromptId, event });
      return true;
    });
  } catch (e) {
    console.error('[promptSessionEvents] appendResponseEventIfKnown error', cwd, sourcePromptId, e);
    return false;
  }
}

module.exports = {
  appendResponseEventIfKnown,
  promptSessionActiveIndexPath,
  attachWindow,
  EVENT_APPENDED_CHANNEL,
};
