/**
 * SuperAgent — "boss" runner that dispatches specialist subagents.
 *
 * Ported (in MVP form) from ClaudeCodeUnleashed's SuperAgent feature.
 * Differs significantly from upstream:
 *   - We don't call Groq/OpenAI. The boss IS Claude — we send a structured
 *     prompt to the active PTY tab asking Claude to act as the boss, pick
 *     specialists, and report progress in a parseable format.
 *   - No autonomous output-parsing / fast-path / WAIT logic. State machine
 *     is renderer-driven via transcript events (see live.ts pattern).
 *   - Per-tab run state lives here so the renderer can poll status across
 *     navigation, and so a future supervisor probe can act on stuck runs.
 *
 * Channels:
 *   superagent:start({ tabId, prompt, specialistCount, depth })
 *     → { ok, error? } and broadcasts the boss prompt to the tab's PTY.
 *   superagent:status(tabId) → SuperAgentRunState | null
 *   superagent:stop(tabId) → { ok }
 *
 * Broadcasts:
 *   superagent:state-changed → { tabId, state } whenever a run starts/stops.
 *
 * The PTY write is intentionally done via the existing ptyManager.write
 * indirection, NOT a fresh spawn — SuperAgent runs inside the user's current
 * Claude session.
 */

const { ipcMain } = require('electron');
const { schemas } = require('./ipcSchemas.cjs');
const { manager: ptyManager } = require('./pty.cjs');
const logs = require('./logs.cjs');

// Per-tab run state. Single live run per tab — starting a new run on a tab
// that's already running stops the existing one first.
//
// Shape (also exposed on the renderer via api.d.ts SuperAgentRunState):
//   { status: 'idle' | 'running' | 'done' | 'error',
//     prompt, specialistCount, depth,
//     startedAt: number | null, finishedAt: number | null,
//     error?: string }
const runs = new Map();

let mainWindow = null;

function attachWindow(win) {
  mainWindow = win;
}

function broadcast(tabId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = runs.get(tabId) ?? null;
  try {
    mainWindow.webContents.send('superagent:state-changed', { tabId, state });
  } catch { /* renderer gone */ }
}

/**
 * Build the prompt we send to Claude to act as the boss. Structured so the
 * renderer can (in a follow-up) pattern-match progress markers off the
 * transcript without us having to parse PTY output ourselves.
 *
 * O(1) string concat — the prompt is bounded by the zod max(8KiB).
 */
function buildBossPrompt({ prompt, specialistCount, depth }) {
  const depthLine = depth === 'quick'
    ? 'Quick pass — surface-level analysis, single-shot specialist work.'
    : depth === 'deep'
      ? 'Deep pass — multi-step plans per specialist, recurse on findings.'
      : 'Standard pass — moderate detail, one or two iterations per specialist.';

  return [
    '## SuperAgent boss mode',
    '',
    `You are coordinating ${specialistCount} specialist subagent(s) for the user's task.`,
    depthLine,
    '',
    'Workflow:',
    `  1. Pick ${specialistCount} specialist subagent type(s) that best match the task.`,
    '     Report them as: [SUPERAGENT] specialists: <type1>, <type2>, ...',
    '  2. Dispatch them via the Task tool, one at a time or in parallel as appropriate.',
    '  3. After each specialist returns, report: [SUPERAGENT] progress: <specialist> done',
    '  4. When the task is complete, summarize results and report: [SUPERAGENT] complete',
    '',
    'User task:',
    prompt,
  ].join('\n');
}

function startRun(payload) {
  const { tabId, prompt, specialistCount, depth } = payload;

  // Stop any in-flight run on this tab — single run-per-tab invariant.
  const existing = runs.get(tabId);
  if (existing && existing.status === 'running') {
    runs.set(tabId, {
      ...existing,
      status: 'done',
      finishedAt: Date.now(),
    });
  }

  const fullPrompt = buildBossPrompt({ prompt, specialistCount, depth });

  // PTY write — exactly the pattern docstring'd at the top of the task brief.
  // The trailing carriage-return submits the prompt in Claude's TUI.
  let writeErr = null;
  try {
    ptyManager.write({ tabId, data: fullPrompt + '\r' });
  } catch (e) {
    writeErr = e?.message ?? String(e);
  }

  if (writeErr) {
    const errState = {
      status: 'error',
      prompt,
      specialistCount,
      depth,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      error: writeErr,
    };
    runs.set(tabId, errState);
    broadcast(tabId);
    logs.writeLine({
      scope: 'superagent',
      level: 'error',
      message: 'start failed',
      meta: { tabId, error: writeErr },
    });
    return { ok: false, error: writeErr };
  }

  const state = {
    status: 'running',
    prompt,
    specialistCount,
    depth,
    startedAt: Date.now(),
    finishedAt: null,
  };
  runs.set(tabId, state);
  broadcast(tabId);

  logs.writeLine({
    scope: 'superagent',
    level: 'info',
    message: 'start',
    meta: { tabId, specialistCount, depth, promptBytes: prompt.length },
  });

  return { ok: true };
}

function stopRun(tabId) {
  const existing = runs.get(tabId);
  if (!existing || existing.status !== 'running') {
    return { ok: true };
  }
  runs.set(tabId, {
    ...existing,
    status: 'done',
    finishedAt: Date.now(),
  });
  broadcast(tabId);
  logs.writeLine({
    scope: 'superagent',
    level: 'info',
    message: 'stop',
    meta: { tabId },
  });
  return { ok: true };
}

function getStatus(tabId) {
  return runs.get(tabId) ?? null;
}

function registerSuperAgentHandlers() {
  ipcMain.handle('superagent:start', (_e, payload) => {
    const parsed = schemas.superagentStart.parse(payload);
    return startRun(parsed);
  });

  ipcMain.handle('superagent:status', (_e, payload) => {
    const { tabId } = schemas.superagentTabId.parse(payload);
    return getStatus(tabId);
  });

  ipcMain.handle('superagent:stop', (_e, payload) => {
    const { tabId } = schemas.superagentTabId.parse(payload);
    return stopRun(tabId);
  });
}

module.exports = {
  attachWindow,
  registerSuperAgentHandlers,
  // Exposed for tests.
  buildBossPrompt,
  _runs: runs,
};
