'use strict';

/**
 * chatRunner.cjs — headless `claude -p --output-format stream-json` runner for
 * the terminal chat UI (PRD 319). Each call spawns a fresh process that exits
 * when done; no idle process lives between commands.
 *
 * Public surface:
 *   run({ tabId, sessionId, prompt, cwd, resume }): Promise<void>  — fire-and-forget
 *   cancel(tabId): void
 *   parseStopSignal(finalText): { questions: string[] } | null     — exported for reuse
 *   STOP_SENTINEL: string                                           — exported for tests
 *
 * IPC events broadcast to the renderer:
 *   chat:run:started    { tabId, sessionId }
 *   chat:run:output     { tabId, delta }
 *   chat:run:complete   { tabId, sessionId, finalMessage }
 *   chat:run:needs-input { tabId, sessionId, questions, raw }
 *   chat:run:error      { tabId, sessionId, message }
 */

const { spawn } = require('node:child_process');
const { ipcMain } = require('electron');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');

// ─── Stop-signal protocol ──────────────────────────────────────────────────
// Single source of truth for the sentinel and parser. The renderer (PRD 320)
// and tests import `parseStopSignal` from here — never re-implement.

const STOP_SENTINEL = '<<<SM_NEEDS_INPUT>>>';

/**
 * Parse the final assistant text for the stop-signal protocol.
 *
 * Returns `{ questions: string[] }` when the sentinel is present with valid
 * JSON on the next line. Returns `null` when the sentinel is absent OR when
 * the JSON is malformed — both cases are treated as a completed run with no
 * crash.
 *
 * @param {string} finalText
 * @returns {{ questions: string[] } | null}
 */
function parseStopSignal(finalText) {
  if (typeof finalText !== 'string') return null;
  const idx = finalText.lastIndexOf(STOP_SENTINEL);
  if (idx === -1) return null;
  // Everything after the sentinel, stripped of leading whitespace
  const after = finalText.slice(idx + STOP_SENTINEL.length).trimStart();
  const firstLine = after.split('\n')[0].trim();
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed && Array.isArray(parsed.questions)) {
      return { questions: parsed.questions };
    }
    return null;
  } catch {
    // Malformed JSON — treat as complete, no crash
    return null;
  }
}

// Instruction prepended to every prompt. Tells the agent how to signal that
// it needs clarification vs. having completed the task.
const STOP_SIGNAL_INSTRUCTION =
  `IMPORTANT: If you need clarification from the user before you can continue, ` +
  `do NOT guess — finish your turn by emitting, as the very last line, exactly:\n` +
  `${STOP_SENTINEL}\n` +
  `followed on the next line by a single-line JSON object {"questions":["..."]}. ` +
  `Otherwise complete the task and end with a concise summary of what you did.\n\n`;

// ─── Concurrency semaphore ─────────────────────────────────────────────────
// Caps in-flight chat runs so we don't exceed the machine-wide "≤3 concurrent
// claude -p" ceiling documented in CLAUDE.md (the scheduler is a separate
// source of jobs). O(1): a Map whose size is the live count.

const DEFAULT_CAP = 2;
// Clamp to [1, 3] — never allow more than 3 regardless of the env override.
const CONCURRENCY_CAP = Math.min(
  3,
  Math.max(1, parseInt(process.env.SM_CHAT_CONCURRENCY || String(DEFAULT_CAP), 10) || DEFAULT_CAP),
);

// tabId → cancel() function for every in-flight run
const inFlight = new Map();

// ─── Hard wall-clock kill ceiling ────────────────────────────────────────
const KILL_CEILING_MS = 30 * 60 * 1000; // 30 minutes

// ─── Window reference (set by attachWindow) ────────────────────────────────

let mainWindow = null;

function attachWindow(win) { mainWindow = win; }

function broadcast(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch { /* render frame may be gone */ }
}

// ─── Core runner ──────────────────────────────────────────────────────────

/**
 * Fire-and-forget: spawn a headless claude -p job for the given tab. Results
 * arrive via IPC events broadcast to the renderer. Returns immediately after
 * launching (or after broadcasting a capacity-error if full).
 *
 * @param {{ tabId: string, sessionId: string, prompt: string, cwd: string, resume: boolean }} opts
 */
async function run({ tabId, sessionId, prompt, cwd, resume }) {
  // O(1) capacity check — Map.size is maintained by the JS runtime
  if (inFlight.size >= CONCURRENCY_CAP) {
    broadcast('chat:run:error', {
      tabId,
      sessionId,
      message: `at capacity (${CONCURRENCY_CAP} concurrent chat runs); try again shortly`,
    });
    return;
  }

  const claudeBin = resolveClaudeBin();
  const childEnv = cleanChildEnv({ PATH: pathWithUserBins() });

  // Prepend the stop-signal protocol instruction to every prompt
  const fullPrompt = STOP_SIGNAL_INSTRUCTION + prompt;

  // Build argv as an array — no shell: true, no string interpolation
  const args = [
    '-p', fullPrompt,
    '--model', 'sonnet',           // pinned per "claude -p model pinning" rule
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (resume) {
    // --resume carries the session context; no --session-id needed
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', sessionId);
  }

  broadcast('chat:run:started', { tabId, sessionId });

  // Spawn with stdin closed (mirrors scheduler's 'ignore' — prevents the
  // "claude -p stdin must be closed" gotcha from kg.cjs). stdout is piped for
  // real-time NDJSON streaming; stderr piped for error-message capture.
  let child;
  try {
    child = spawn(claudeBin, args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group so killTree can SIGTERM descendants
    });
  } catch (err) {
    broadcast('chat:run:error', {
      tabId,
      sessionId,
      message: `spawn failed: ${err?.message ?? String(err)}`,
    });
    return;
  }

  // One-shot kill helper — idempotent via the `killed` flag
  let killed = false;
  const doKill = (sig) => {
    if (killed) return;
    killed = true;
    // Negative pid targets the process group (requires detached: true)
    try { process.kill(-child.pid, sig); }
    catch { try { child.kill(sig); } catch { /* already dead */ } }
  };

  const cancelFn = () => {
    doKill('SIGTERM');
    setTimeout(() => doKill('SIGKILL'), 5000).unref?.();
  };

  inFlight.set(tabId, cancelFn);

  // Hard wall-clock ceiling — SIGTERM + SIGKILL on expiry
  const killTimer = setTimeout(() => {
    broadcast('chat:run:error', {
      tabId,
      sessionId,
      message: 'run exceeded 30-minute wall-clock ceiling',
    });
    cancelFn();
  }, KILL_CEILING_MS);
  if (killTimer.unref) killTimer.unref();

  // ─── Stream parsing ──────────────────────────────────────────────────────
  // stdout is newline-delimited JSON (stream-json format). We buffer partial
  // lines across TCP/pipe chunks. O(output-size) in memory per run.

  let lineBuffer = '';
  let finalAssistantText = '';
  let stderrBuffer = '';
  let gotResult = false;

  const processLine = (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }

    if (event.type === 'assistant') {
      // Content blocks carry the actual text deltas
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          finalAssistantText += block.text;
          broadcast('chat:run:output', { tabId, delta: block.text });
        }
      }
    } else if (event.type === 'result') {
      gotResult = true;
      // Use the authoritative `result` field when available; fall back to
      // accumulated assistant text (same content, different source).
      const text = typeof event.result === 'string' ? event.result : finalAssistantText;

      if (event.subtype === 'success') {
        const signal = parseStopSignal(text);
        if (signal) {
          broadcast('chat:run:needs-input', {
            tabId,
            sessionId,
            questions: signal.questions,
            raw: text,
          });
        } else {
          broadcast('chat:run:complete', { tabId, sessionId, finalMessage: text });
        }
      } else {
        broadcast('chat:run:error', {
          tabId,
          sessionId,
          message: `run ended with result subtype: ${event.subtype ?? 'unknown'}`,
        });
      }
    }
  };

  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString('utf8');
    let nl;
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      processLine(lineBuffer.slice(0, nl).trim());
      lineBuffer = lineBuffer.slice(nl + 1);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
  });

  child.on('error', (err) => {
    clearTimeout(killTimer);
    inFlight.delete(tabId);
    broadcast('chat:run:error', {
      tabId,
      sessionId,
      message: err?.message ?? String(err),
    });
  });

  child.on('exit', (code, signal) => {
    clearTimeout(killTimer);
    inFlight.delete(tabId);
    // Flush any partial line that didn't end with \n
    if (lineBuffer.trim()) processLine(lineBuffer.trim());

    if (!gotResult && !killed) {
      const errDetail = stderrBuffer.trim()
        ? `: ${stderrBuffer.trim().slice(0, 300)}`
        : '';
      broadcast('chat:run:error', {
        tabId,
        sessionId,
        message: `process exited without a result event (code=${code} signal=${signal})${errDetail}`,
      });
    }
  });
}

/**
 * Cancel an in-flight run for the given tabId. No-op when not running.
 */
function cancel(tabId) {
  const fn = inFlight.get(tabId);
  if (fn) {
    fn();
    inFlight.delete(tabId);
  }
}

// ─── IPC handler registration ─────────────────────────────────────────────

function registerChatHandlers() {
  const { schemas, validated } = require('./ipcSchemas.cjs');

  ipcMain.handle('chat:run', validated(schemas.chatRun, async ({ tabId, sessionId, prompt, cwd, resume }) => {
    await run({ tabId, sessionId, prompt, cwd, resume: !!resume });
    return { ok: true };
  }));

  ipcMain.on('chat:cancel', (_e, payload) => {
    let tabId;
    try { tabId = schemas.chatCancel.parse(payload).tabId; } catch { return; }
    cancel(tabId);
  });
}

module.exports = {
  run,
  cancel,
  attachWindow,
  registerChatHandlers,
  parseStopSignal,
  STOP_SENTINEL,
};
