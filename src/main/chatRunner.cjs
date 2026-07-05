'use strict';

/**
 * chatRunner.cjs — headless `claude -p --output-format stream-json` runner for
 * the terminal chat UI (PRD 319). Each call spawns a fresh process that exits
 * when done; no idle process lives between commands.
 *
 * v0.34: runs are serialized through a FIFO queue — ONE loop at a time by
 * default (SM_CHAT_CONCURRENCY overrides, clamped to [1,3]). Extra submits
 * queue instead of erroring; modeled on the scheduler's serialized queue so a
 * burst of commands across tabs can't fan out into the parallel-`claude -p`
 * OOM that SIGKILLed a job on 2026-06-26.
 *
 * Public surface:
 *   run({ tabId, sessionId, prompt, cwd, resume }): void  — fire-and-forget enqueue
 *   cancel(tabId): void
 *   parseStopSignal(finalText): { questions: string[] } | null     — exported for reuse
 *   STOP_SENTINEL: string                                           — exported for tests
 *   __setExecutor(fn): void                                         — test seam
 *
 * IPC events broadcast to the renderer:
 *   chat:run:queued     { tabId, sessionId, position }   — waiting behind a busy lane
 *   chat:run:started    { tabId, sessionId }
 *   chat:run:output     { tabId, delta }
 *   chat:run:tool-use   { tabId, id, kind, label }
 *   chat:run:complete   { tabId, sessionId, finalMessage }
 *   chat:run:needs-input { tabId, sessionId, questions, raw }
 *   chat:run:error      { tabId, sessionId, message }
 */

const { spawn } = require('node:child_process');
const { ipcMain } = require('electron');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const { recordExchange } = require('./exchanges.cjs');
const { classifyToolUse } = require('./lib/toolUseClassify.cjs');

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

// ─── Serial run queue (v0.34) ───────────────────────────────────────────────
// CONCURRENCY_CAP=1 (default) → one loop at a time. The cap is the machine-wide
// "≤3 concurrent claude -p" ceiling from CLAUDE.md; default 1 is the v0.34
// guarantee. The waiting list FIFO-queues anything that can't start yet.

const DEFAULT_CAP = 1;
// Clamp to [1, 3]; default 1 = "one loop at a time".
const CONCURRENCY_CAP = Math.min(
  3,
  Math.max(1, parseInt(process.env.SM_CHAT_CONCURRENCY || String(DEFAULT_CAP), 10) || DEFAULT_CAP),
);

// tabId → cancel() for every ACTIVE run; FIFO list of WAITING runs; live count.
const inFlight = new Map();
const waiting = []; // [{ tabId, sessionId, prompt, cwd, resume }]
let activeCount = 0;

// Indirection so tests can stub the spawn without launching claude.
let executor = executeRun;
function __setExecutor(fn) { executor = fn || executeRun; }

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

// ─── Public queue entry ─────────────────────────────────────────────────────

/**
 * Enqueue a chat run for a tab. Fire-and-forget — results arrive via IPC. With
 * CONCURRENCY_CAP=1 (default) runs execute one at a time; extra submits FIFO-
 * queue and are announced via chat:run:queued. De-dupes a tab already in the
 * pipeline (the UI disables input while running, but guard anyway).
 *
 * @param {{ tabId: string, sessionId: string, prompt: string, cwd: string, resume: boolean }} opts
 */
function run(opts) {
  if (inFlight.has(opts.tabId) || waiting.some((w) => w.tabId === opts.tabId)) return;
  waiting.push(opts);
  pump();
}

// Fill open lanes FIFO up to CONCURRENCY_CAP, then announce queue positions for
// the remainder. O(n) over the waiting list (bounded by open tabs).
function pump() {
  while (activeCount < CONCURRENCY_CAP && waiting.length > 0) {
    const job = waiting.shift();
    activeCount += 1;
    Promise.resolve()
      .then(() => executor(job))
      .catch(() => { /* executeRun never rejects; defensive */ })
      .finally(() => { activeCount -= 1; pump(); });
  }
  // Anyone still waiting gets a 1-based position update.
  waiting.forEach((w, i) => {
    broadcast('chat:run:queued', { tabId: w.tabId, sessionId: w.sessionId, position: i + 1 });
  });
}

// ─── Core runner ──────────────────────────────────────────────────────────

/**
 * Spawn the headless claude -p child for ONE run and resolve when it fully
 * settles (exit / error / spawn failure). Registers a cancel fn in `inFlight`
 * for the run's lifetime so cancel() can reach it. Never rejects — the queue
 * pump relies on the returned promise always settling so the lane frees.
 *
 * @param {{ tabId: string, sessionId: string, prompt: string, cwd: string, resume: boolean }} opts
 * @returns {Promise<void>}
 */
function executeRun({ tabId, sessionId, prompt, cwd, resume }) {
  return new Promise((resolve) => {
    let settled = false;
    // Frees the lane exactly once: drops the cancel fn and resolves the promise
    // the pump is awaiting. Both exit and error paths funnel through here.
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight.delete(tabId);
      resolve();
    };

    // Guarantees the renderer receives EXACTLY ONE terminal event
    // (complete / needs-input / error) per run. Without this, a cancelled or
    // killed run exits with `killed=true` and the old exit-guard broadcast
    // nothing — leaving the chat store stuck at running:true forever (disabled
    // textarea, "running…" spinner, unresponsive UI). Every terminal broadcast
    // funnels through here so the exit path can emit a fallback only when the
    // run settled without one.
    let terminalSent = false;
    const emitTerminal = (channel, payload) => {
      if (terminalSent) return;
      terminalSent = true;
      broadcast(channel, payload);
    };

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
      emitTerminal('chat:run:error', {
        tabId,
        sessionId,
        message: `spawn failed: ${err?.message ?? String(err)}`,
      });
      settle();
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
      emitTerminal('chat:run:error', {
        tabId,
        sessionId,
        message: 'run exceeded 30-minute wall-clock ceiling',
      });
      cancelFn();
    }, KILL_CEILING_MS);
    if (killTimer.unref) killTimer.unref();

    // ─── Stream parsing ────────────────────────────────────────────────────
    // stdout is newline-delimited JSON (stream-json format). We buffer partial
    // lines across TCP/pipe chunks. O(output-size) in memory per run.

    let lineBuffer = '';
    let finalAssistantText = '';
    let stderrBuffer = '';

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
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const classified = classifyToolUse(block);
            broadcast('chat:run:tool-use', { tabId, id: block.id, ...classified });
          }
        }
      } else if (event.type === 'result') {
        // Use the authoritative `result` field when available; fall back to
        // accumulated assistant text (same content, different source).
        const text = typeof event.result === 'string' ? event.result : finalAssistantText;

        if (event.subtype === 'success') {
          const signal = parseStopSignal(text);
          if (signal) {
            emitTerminal('chat:run:needs-input', {
              tabId,
              sessionId,
              questions: signal.questions,
              raw: text,
            });
          } else {
            emitTerminal('chat:run:complete', { tabId, sessionId, finalMessage: text });
            // Record durable exchange off the hot path — UI must not wait on Haiku
            recordExchange({ sessionId, cwd, prompt, result: text }).catch((err) => {
              console.error('[chatRunner] recordExchange failed:', err?.message ?? err);
            });
          }
        } else {
          emitTerminal('chat:run:error', {
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
      emitTerminal('chat:run:error', {
        tabId,
        sessionId,
        message: err?.message ?? String(err),
      });
      settle();
    });

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      // Flush any partial line that didn't end with \n
      if (lineBuffer.trim()) processLine(lineBuffer.trim());

      // Emit a fallback terminal event for any run that ended without one — a
      // cancel/SIGTERM (killed=true), a crash before a result, or a silent
      // exit. `emitTerminal` no-ops if the run already sent complete/needs-
      // input/error, so the normal success path never double-fires. This is
      // what unsticks the renderer's running flag after Cancel.
      if (!terminalSent) {
        if (killed) {
          emitTerminal('chat:run:error', {
            tabId,
            sessionId,
            message: 'run cancelled',
          });
        } else {
          const errDetail = stderrBuffer.trim()
            ? `: ${stderrBuffer.trim().slice(0, 300)}`
            : '';
          emitTerminal('chat:run:error', {
            tabId,
            sessionId,
            message: `process exited without a result event (code=${code} signal=${signal})${errDetail}`,
          });
        }
      }
      settle();
    });
  });
}

/**
 * Cancel a run for the given tabId. An ACTIVE run is SIGTERM→SIGKILL'd (its
 * child exit funnels through settle → pump, freeing the lane). A still-WAITING
 * run is dropped from the queue and announced as cancelled. No-op otherwise.
 */
function cancel(tabId) {
  const fn = inFlight.get(tabId);
  if (fn) {
    fn(); // settle() (on child exit) deletes from inFlight + pumps the next run
    return;
  }
  const idx = waiting.findIndex((w) => w.tabId === tabId);
  if (idx !== -1) {
    const [w] = waiting.splice(idx, 1);
    broadcast('chat:run:error', {
      tabId: w.tabId,
      sessionId: w.sessionId,
      message: 'cancelled while queued',
    });
    pump(); // refresh remaining queue positions
  }
}

// ─── IPC handler registration ─────────────────────────────────────────────

function registerChatHandlers() {
  const { schemas, validated } = require('./ipcSchemas.cjs');

  ipcMain.handle('chat:run', validated(schemas.chatRun, async ({ tabId, sessionId, prompt, cwd, resume }) => {
    run({ tabId, sessionId, prompt, cwd, resume: !!resume });
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
  __setExecutor,
};
