'use strict';

/**
 * chatRunner.cjs — headless `claude -p --output-format stream-json` runner for
 * the terminal chat UI (PRD 319). Each call spawns a fresh process that exits
 * when done; no idle process lives between commands.
 *
 * v0.34: silent (automated) runs are serialized through a FIFO queue capped at
 * CONCURRENCY_CAP (SM_CHAT_CONCURRENCY overrides, clamped to [1,3]); modeled
 * on the scheduler's serialized queue so a burst of probes can't fan out into
 * the parallel-`claude -p` OOM that SIGKILLed a job on 2026-06-26.
 * PRD 493 had manual, user-initiated runs bypass that lane entirely (always
 * immediate, uncapped). A later PRD (per-tab prompt queue) folded manual runs
 * back into the SAME FIFO lane — a per-tab queue in the renderer (chat.ts)
 * now only ever calls run() once per tab at a time, so the cap governs
 * cross-tab fan-out, not per-tab ordering.
 *
 * Public surface:
 *   run({ tabId, sessionId, prompt, cwd, resume, silent }): void  — fire-and-forget enqueue.
 *     Both silent (PRD 470) and manual runs go through the same CONCURRENCY_CAP FIFO lane.
 *     Silent runs additionally suppress the six turn-affecting broadcasts + recordExchange
 *     (see probeContextUsage below).
 *   cancel(tabId): Promise<void>  — resolves once the cancelled run fully settles
 *   parseStopSignal(finalText): { questions: string[] } | null     — exported for reuse
 *   parseContextUsageMarkdown(text): { usedTokens, totalTokens, usedPct, categories } | null
 *                                                                    — pure parser for `/context`
 *   probeContextUsage({ tabId, sessionId, cwd }): void  — fire-and-forget silent `/context` probe
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
 *                         — the kill-ceiling variant additionally carries
 *                           { elapsedMs, ceilingMs, lastToolUses } so a resumed
 *                           turn can tell whether an external side effect
 *                           landed before verifying/retrying
 *   chat:run:notice     { tabId, sessionId, message }        — informational, not terminal
 *                         (also fires at 80% of the kill ceiling as a wrap-up nudge)
 *   chat:context-usage  { tabId, sessionId, usedTokens, totalTokens, usedPct, categories }
 *                                                             — result of a silent `/context` probe
 */

const { spawn } = require('node:child_process');
const { ipcMain } = require('electron');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const { recordExchange } = require('./exchanges.cjs');
const { classifyToolUse } = require('./lib/toolUseClassify.cjs');
const { extractJson } = require('./lib/extractJson.cjs');
const { classifyPromptTicket } = require('./lib/classifyPromptTicket.cjs');
const sessionSlots = require('./lib/sessionSlots.cjs');

// ─── Stop-signal protocol ──────────────────────────────────────────────────
// Single source of truth for the sentinel and parser. The renderer (PRD 320)
// and tests import `parseStopSignal` from here — never re-implement.

const STOP_SENTINEL = '<<<SM_NEEDS_INPUT>>>';

/**
 * Split the final assistant text at the stop-signal sentinel.
 *
 * Returns `{ answerBody: string, questions: string[] }` when the sentinel is
 * present and a balanced JSON object with a `questions` array can be found
 * anywhere in the text after it (tolerant of leading blank lines, code-fence
 * wrapping, multi-line pretty-printing, and trailing prose after the closing
 * `}`). `answerBody` is everything before the LAST sentinel occurrence, with
 * the trailing sentinel line and JSON line removed and whitespace trimmed —
 * an earlier literal sentinel string embedded in the agent's own answer text
 * is preserved as part of `answerBody` (lastIndexOf semantics).
 * Returns `null` when the sentinel is absent OR when no such JSON object is
 * found after it — both cases are treated as a completed run with no crash.
 *
 * @param {string} finalText
 * @returns {{ answerBody: string, questions: string[] } | null}
 */
function splitStopSignal(finalText) {
  if (typeof finalText !== 'string') return null;
  const idx = finalText.lastIndexOf(STOP_SENTINEL);
  if (idx === -1) return null;
  const after = finalText.slice(idx + STOP_SENTINEL.length);
  const parsed = extractJson(after);
  if (parsed && Array.isArray(parsed.questions)) {
    const answerBody = finalText.slice(0, idx).trim();
    return { answerBody, questions: parsed.questions };
  }
  return null;
}

/**
 * Parse the final assistant text for the stop-signal protocol.
 *
 * Thin wrapper over `splitStopSignal` — kept for existing callers that only
 * need the questions, not the pre-sentinel answer body.
 *
 * @param {string} finalText
 * @returns {{ questions: string[] } | null}
 */
function parseStopSignal(finalText) {
  const split = splitStopSignal(finalText);
  return split ? { questions: split.questions } : null;
}

// ─── `/context` probe (PRD 470) ────────────────────────────────────────────
// `claude -p "/context"` is answered entirely locally by the CLI (zero-cost,
// no real API call) with markdown containing a summary line and a per-category
// breakdown table. Parsed here so the app can mirror the CLI's own context-
// window accounting without re-implementing the estimate itself.

// "9k" -> 9000, "15.1k" -> 15100; bare "207" -> 207. Never throws — returns NaN
// for genuinely malformed input, which callers treat as a parse failure.
function parseTokenAmount(str) {
  const suffixed = /^(\d+(?:\.\d+)?)k$/i.exec(str);
  if (suffixed) return Math.round(parseFloat(suffixed[1]) * 1000);
  return Number(str);
}

/**
 * Parse the markdown produced by the CLI's own `/context` slash command into
 * a structured summary. Pure, single line-by-line pass — O(n) over the lines
 * of a small, bounded response, no nested scans.
 *
 * @param {string} text
 * @returns {{ usedTokens: number, totalTokens: number, usedPct: number, categories: Array<{ category: string, tokens: number, pct: number }> } | null}
 */
function parseContextUsageMarkdown(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split('\n');

  let usedTokens = null;
  let totalTokens = null;
  let usedPct = null;
  const tokensLineRe = /\*\*Tokens:\*\*\s*(\S+)\s*\/\s*(\S+)\s*\(([\d.]+)%\)/;

  let inTable = false;
  let foundHeading = false;
  const categories = [];

  for (const line of lines) {
    if (usedTokens === null) {
      const m = tokensLineRe.exec(line);
      if (m) {
        usedTokens = parseTokenAmount(m[1]);
        totalTokens = parseTokenAmount(m[2]);
        usedPct = Number(m[3]);
      }
    }

    if (!inTable) {
      if (line.trim() === '### Estimated usage by category') {
        foundHeading = true;
        inTable = true;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('###')) { inTable = false; continue; }
    if (!trimmed.startsWith('|')) continue;

    const cells = trimmed.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length !== 3) continue;
    if (cells[0].toLowerCase() === 'category') continue; // header row
    if (/^:?-+:?$/.test(cells[0])) continue; // separator row

    const tokens = parseTokenAmount(cells[1]);
    const pctMatch = /^([\d.]+)%$/.exec(cells[2]);
    if (!pctMatch || Number.isNaN(tokens)) continue;
    categories.push({ category: cells[0], tokens, pct: Number(pctMatch[1]) });
  }

  if (
    usedTokens === null || totalTokens === null || usedPct === null ||
    Number.isNaN(usedTokens) || Number.isNaN(totalTokens) || Number.isNaN(usedPct) ||
    !foundHeading || categories.length === 0
  ) {
    return null;
  }

  return { usedTokens, totalTokens, usedPct, categories };
}

/**
 * Fire-and-forget silent probe of the resumed session's context usage. Reuses
 * the normal `run()` queue/lane (resume: true, silent: true) so it can never
 * race a real chat run against the same `--resume sessionId`. Broadcasts
 * `chat:context-usage` on success; logs (never throws/broadcasts) on a parse
 * failure.
 *
 * @param {{ tabId: string, sessionId: string, cwd: string }} params
 */
function probeContextUsage({ tabId, sessionId, cwd }) {
  run({
    tabId,
    sessionId,
    prompt: '/context',
    cwd,
    resume: true,
    silent: true,
    onSilentResult: (text) => {
      const parsed = parseContextUsageMarkdown(text);
      if (!parsed) {
        console.error('[chatRunner] parseContextUsageMarkdown failed to parse /context probe output');
        return;
      }
      broadcast('chat:context-usage', {
        tabId,
        sessionId,
        usedTokens: parsed.usedTokens,
        totalTokens: parsed.totalTokens,
        usedPct: parsed.usedPct,
        categories: parsed.categories,
      });
    },
  });
}

// ─── MCP consent-denial detection ──────────────────────────────────────────
// Best-effort substring heuristic over known CLI phrasing — NOT a documented
// stream-json schema field. Confirmed by extracting strings from the compiled
// `claude` CLI binary (2.1.207): a non-interactive/`-p` run that hits an
// MCP server requiring first-party consent (e.g. `claude_design`) throws a
// tool error whose message is exactly:
//   "<tool label> The user hasn't granted this — run /design consent to
//   grant it (it can't be approved automatically in this permission mode)."
// which surfaces to stdout as a `tool_result` block (is_error: true) inside a
// `type: "user"` stream-json event. Since consent flows exist for MCP servers
// beyond `claude_design`, match on the generic phrasing rather than the
// design-specific slash command.
const MCP_CONSENT_DENIAL_MARKERS = [
  "hasn't granted this",
  'run /design consent',
  'connect to claude design',
  'requires consent',
  'needs a claude.ai credential',
];

function hasMcpConsentDenial(text) {
  if (typeof text !== 'string' || !text) return false;
  const lower = text.toLowerCase();
  return MCP_CONSENT_DENIAL_MARKERS.some((marker) => lower.includes(marker));
}

// Number of recent tool uses kept for the kill-message context (Ask 3).
const RECENT_TOOL_USE_LIMIT = 3;
const TOOL_USE_DETAIL_MAX_LEN = 60;

// Renders a single classified tool_use (from classifyToolUse) plus a short
// input-derived detail string into a human-readable descriptor, e.g.
// "Bash(eas submit --platform ios …)". Pure formatting — no new stream
// parsing; `detail` is lifted from the same already-parsed block.
function renderToolUseDescriptor({ label, detail }) {
  if (!detail) return label;
  const truncated = detail.length > TOOL_USE_DETAIL_MAX_LEN
    ? `${detail.slice(0, TOOL_USE_DETAIL_MAX_LEN)}…`
    : detail;
  return `${label}(${truncated})`;
}

// Pulls a short descriptive string out of a tool_use block's input, reusing
// fields already present on the already-parsed block — not a new parser.
function describeToolUseInput(block) {
  const input = block?.input;
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.description === 'string') return input.description;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.file_path === 'string') return input.file_path;
  return '';
}

// Instruction prepended to every prompt. Tells the agent how to signal that
// it needs clarification vs. having completed the task.
const STOP_SIGNAL_INSTRUCTION =
  `IMPORTANT: First deliver everything you CAN answer or produce right now — findings, ` +
  `the requested content, work already completed — as normal output. Only THEN, if ` +
  `something still blocks you from finishing, end your turn by emitting, as the very ` +
  `last line, exactly:\n` +
  `${STOP_SENTINEL}\n` +
  `followed on the next line by a single-line JSON object {"questions":["..."]}. ` +
  `Never make the question your entire reply when the user asked for content — do NOT ` +
  `guess on what's genuinely blocked, but always answer what you can first. ` +
  `Otherwise complete the task and end with a concise summary of what you did.\n\n`;

// ─── Hard wall-clock kill ceiling ────────────────────────────────────────
// Defined here (ahead of CHAT_MODE_TRUTH_INSTRUCTION) so the prompt's stated
// budget is always derived from this single constant — never a hand-written
// duplicate that could drift from the real timer below.
const KILL_CEILING_MS = 30 * 60 * 1000; // 30 minutes
const KILL_CEILING_MIN = KILL_CEILING_MS / 60_000;
// 80% warning point — gives the model a turn-visible nudge to wrap up before
// the hard kill fires at 100%. Not configurable; see PRD out-of-scope note
// re: making KILL_CEILING_MS itself configurable.
const WARN_CEILING_MS = Math.floor(KILL_CEILING_MS * 0.8);

// Instruction prepended to every prompt. Tells the agent the truth about this
// execution mode: this Chat tab is a one-shot headless `claude -p` run — no
// process survives after this turn ends, so background shells, scheduled
// wake-ups, or "I'll get back to you" plans are impossible here.
const CHAT_MODE_TRUTH_INSTRUCTION =
  `IMPORTANT: This is a one-shot headless run. No process survives after this ` +
  `turn ends — when you stop producing output, the session is torn down and ` +
  `nothing will resume it. Do NOT launch a run_in_background shell to poll ` +
  `something long-running, do NOT schedule a wake-up, and do NOT say "I'll ` +
  `report back once X finishes" or "I'll keep watching and let you know" — ` +
  `there is no later turn in which that could happen, so that promise would ` +
  `go unfulfilled and leave the user waiting with no explanation. If you need ` +
  `to poll something, do it synchronously within this turn with a bounded ` +
  `timeout, then report the actual result. This turn is hard-killed after ` +
  `${KILL_CEILING_MIN} minutes of wall-clock. Size every synchronous poll to ` +
  `finish inside that budget; if the work cannot fit, do the part that fits, ` +
  `report exactly what landed, and say what remains. End this turn with ` +
  `either a real result or an explicit statement that the user needs to ` +
  `reply for the work to continue.\n\n`;

// ─── Serial run queue (v0.34) ───────────────────────────────────────────────
// CONCURRENCY_CAP=2 (default) governs ALL runs — silent probes and manual
// sends alike share one FIFO lane; two can run at once across all tabs before
// a 3rd queues. SM_CHAT_CONCURRENCY still overrides, clamped to [1, 3].

const DEFAULT_CAP = 2;
// Clamp to [1, 3]; default 2 = "two loops at a time". Read lazily (not
// captured at module-load time) so tests can stub the env per-case without
// vi.resetModules(); production behavior is unaffected since the env var
// never changes mid-process.
function getConcurrencyCap() {
  return Math.min(
    3,
    Math.max(1, parseInt(process.env.SM_CHAT_CONCURRENCY || String(DEFAULT_CAP), 10) || DEFAULT_CAP),
  );
}

// tabId → { cancelFn, donePromise } for every ACTIVE run; FIFO list of WAITING
// runs; live count. `donePromise` resolves once the run's own executeRun()
// promise settles (i.e. after settle() runs for that tabId) — attached right
// after the executor is invoked (see run()/pump()) so cancel() callers can
// await full teardown instead of firing SIGTERM and returning immediately.
const inFlight = new Map();
const waiting = []; // [{ tabId, sessionId, prompt, cwd, resume, silent, onSilentResult }]
let activeCount = 0;

// Indirection so tests can stub the spawn without launching claude.
let executor = executeRun;
function __setExecutor(fn) { executor = fn || executeRun; }

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
 * Enqueue a chat run for a tab. Fire-and-forget — results arrive via IPC.
 * Both silent (automated probe) and manual (user-initiated) runs share the
 * CONCURRENCY_CAP=2 (default) FIFO lane — extra submits queue and are
 * announced via chat:run:queued (silent runs stay invisible to the renderer;
 * see pump() below). De-dupes a tab already in the pipeline (the renderer's
 * per-tab prompt queue in chat.ts only ever calls this once per tab at a
 * time, but the guard holds regardless).
 *
 * @param {{ tabId: string, sessionId: string, prompt: string, cwd: string, resume: boolean, silent?: boolean, onSilentResult?: (text: string) => void, promptId?: string }} opts
 */
function run(opts) {
  // Per-tab exclusivity guard — unrelated to the cross-tab cap; must hold for
  // BOTH manual and silent runs so a manual send can't race a /context probe
  // for the same tab against the same --resume sessionId.
  if (inFlight.has(opts.tabId) || waiting.some((w) => w.tabId === opts.tabId)) return;

  waiting.push(opts);
  pump();
}

// Fill open lanes FIFO up to CONCURRENCY_CAP, then announce queue positions for
// the remainder. O(n) over the waiting list (bounded by open tabs).
function pump() {
  while (activeCount < getConcurrencyCap() && waiting.length > 0) {
    // The chat lane cap is a POLICY bound; actual capacity comes from the
    // Session-Manager-wide slot pool shared with the scheduler
    // (lib/sessionSlots.cjs). No slot → everyone keeps waiting; the next
    // settle() in either subsystem re-pumps.
    const slotToken = sessionSlots.acquire(`chat:${waiting[0].tabId}`);
    if (!slotToken) break;
    const job = waiting.shift();
    activeCount += 1;
    Promise.resolve()
      .then(() => {
        const donePromise = executor(job);
        const entry = inFlight.get(job.tabId);
        if (entry) entry.donePromise = donePromise;
        return donePromise;
      })
      .catch(() => { /* executeRun never rejects; defensive */ })
      .finally(() => { sessionSlots.release(slotToken); activeCount -= 1; pump(); });
  }
  // Anyone still waiting gets a 1-based position update. Silent (automated
  // probe) runs must stay invisible to the renderer, same as every other
  // broadcast in executeRun — otherwise a queued probe would flip a tab's
  // `running`/`queuedPosition` UI state for a run the user never initiated.
  waiting.forEach((w, i) => {
    if (w.silent) return;
    broadcast('chat:run:queued', { tabId: w.tabId, sessionId: w.sessionId, position: i + 1 });
  });
}

// A slot freed anywhere (e.g. a scheduler job settled) may unblock our lane.
sessionSlots.subscribe(() => { try { pump(); } catch { /* defensive */ } });

// ─── Core runner ──────────────────────────────────────────────────────────

/**
 * Spawn the headless claude -p child for ONE run and resolve when it fully
 * settles (exit / error / spawn failure). Registers a cancel fn in `inFlight`
 * for the run's lifetime so cancel() can reach it. Never rejects — the queue
 * pump relies on the returned promise always settling so the lane frees.
 *
 * @param {{ tabId: string, sessionId: string, prompt: string, cwd: string, resume: boolean, silent?: boolean, onSilentResult?: (text: string) => void, promptId?: string }} opts
 * @returns {Promise<void>}
 */
function executeRun({ tabId, sessionId, prompt, cwd, resume, silent, onSilentResult, promptId }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // Last few tool_use blocks seen on the stream, oldest first — surfaced in
    // the kill message (Ask 3) so a resumed turn knows what might have landed.
    const recentToolUses = [];
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
      // Silent (probe) runs still need this bookkeeping so the lane frees
      // correctly, but must never surface on the six turn-affecting channels.
      if (silent) return;
      broadcast(channel, payload);
    };

    // Separate one-shot guard for the MCP-consent notice (orthogonal to
    // terminalSent — a run can hit this mid-stream and still legitimately
    // finish with a normal complete/error afterward).
    let noticeSent = false;
    const emitNoticeOnce = () => {
      if (noticeSent) return;
      noticeSent = true;
      broadcast('chat:run:notice', {
        tabId,
        sessionId,
        message:
          'This run needs interactive consent for an MCP server (e.g. Claude Design), which ' +
          "can't be granted in chat mode because stdin is closed for headless runs. Open a " +
          'raw terminal session for this tab ("Back to chat" toggle) and grant consent there, ' +
          'then retry.',
      });
    };

    const claudeBin = resolveClaudeBin();
    const childEnv = cleanChildEnv({ PATH: pathWithUserBins() });

    // Prepend the stop-signal protocol instruction and the chat-mode truth
    // instruction to every prompt
    const fullPrompt = STOP_SIGNAL_INSTRUCTION + CHAT_MODE_TRUTH_INSTRUCTION + prompt;

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

    if (!silent) broadcast('chat:run:started', { tabId, sessionId });

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

    // donePromise is attached by the caller (run()/pump()) right after this
    // executor invocation returns — see comment above the inFlight Map decl.
    inFlight.set(tabId, { cancelFn, donePromise: null });

    // 80%-of-ceiling warning — a turn-visible nudge to wrap up before the hard
    // kill fires at 100%. Does not extend or otherwise affect the kill timer
    // below; it is purely informational (Ask 2).
    const warnTimer = setTimeout(() => {
      if (silent) return; // silent probes are short-lived; nothing to warn
      broadcast('chat:run:notice', {
        tabId,
        sessionId,
        message:
          `Heads up: this turn has been running for ${Math.round(WARN_CEILING_MS / 60_000)} ` +
          `minutes and will be force-killed at the ${KILL_CEILING_MIN}-minute ceiling if it's ` +
          `still going. Wrap up now — report exactly what has landed so far and what remains, ` +
          `before the hard kill fires.`,
      });
    }, WARN_CEILING_MS);
    if (warnTimer.unref) warnTimer.unref();

    // Hard wall-clock ceiling — SIGTERM + SIGKILL on expiry
    const killTimer = setTimeout(() => {
      const elapsedMs = Date.now() - startedAt;
      const lastToolUses = recentToolUses.slice();
      const lastActionsText = lastToolUses.length > 0
        ? lastToolUses.map(renderToolUseDescriptor).join(', ')
        : 'none observed';
      emitTerminal('chat:run:error', {
        tabId,
        sessionId,
        elapsedMs,
        ceilingMs: KILL_CEILING_MS,
        lastToolUses,
        message:
          `Killed after ${Math.round(elapsedMs / 60_000)}m (ceiling ${KILL_CEILING_MIN}m). ` +
          `Last actions: ${lastActionsText}. External side effects may have completed — verify ` +
          `before retrying.`,
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
            if (!silent) broadcast('chat:run:output', { tabId, delta: block.text });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const classified = classifyToolUse(block);
            recentToolUses.push({ ...classified, detail: describeToolUseInput(block) });
            if (recentToolUses.length > RECENT_TOOL_USE_LIMIT) recentToolUses.shift();
            if (!silent) broadcast('chat:run:tool-use', { tabId, id: block.id, ...classified });
          }
        }
      } else if (event.type === 'user') {
        // Tool results come back as content blocks on a synthetic "user" event.
        // An MCP consent-denial surfaces here as an is_error tool_result whose
        // text carries one of MCP_CONSENT_DENIAL_MARKERS.
        const content = Array.isArray(event.message?.content) ? event.message.content : [];
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const inner = block.content;
          const text = typeof inner === 'string'
            ? inner
            : Array.isArray(inner)
              ? inner.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
              : '';
          if (hasMcpConsentDenial(text)) emitNoticeOnce();
        }
      } else if (event.type === 'result') {
        // Use the authoritative `result` field when available; fall back to
        // accumulated assistant text (same content, different source).
        const text = typeof event.result === 'string' ? event.result : finalAssistantText;

        if (event.subtype === 'success') {
          if (silent) {
            // Silent probe: no turn broadcast, no recordExchange — just hand
            // the final text to whoever enqueued the probe (e.g. probeContextUsage).
            emitTerminal('chat:run:complete', { tabId, sessionId, finalMessage: text });
            if (typeof onSilentResult === 'function') onSilentResult(text);
          } else {
            const signal = splitStopSignal(text);
            if (signal) {
              emitTerminal('chat:run:needs-input', {
                tabId,
                sessionId,
                questions: signal.questions,
                answerBody: signal.answerBody,
                raw: text,
              });
              // Record durable exchange off the hot path — UI must not wait on Haiku
              recordExchange({
                sessionId,
                cwd,
                prompt,
                result: `${signal.answerBody}\n\n[asked: ${signal.questions.join(' | ')}]`,
                promptId,
              }).catch((err) => {
                console.error('[chatRunner] recordExchange failed:', err?.message ?? err);
              });
            } else {
              emitTerminal('chat:run:complete', { tabId, sessionId, finalMessage: text });
              // Record durable exchange off the hot path — UI must not wait on Haiku
              recordExchange({ sessionId, cwd, prompt, result: text, promptId }).catch((err) => {
                console.error('[chatRunner] recordExchange failed:', err?.message ?? err);
              });
            }
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
      clearTimeout(warnTimer);
      emitTerminal('chat:run:error', {
        tabId,
        sessionId,
        message: err?.message ?? String(err),
      });
      settle();
    });

    // 'close' (not 'exit') so this fallback only runs after Node guarantees
    // every buffered stdout 'data' chunk has been delivered — 'exit' can fire
    // before the final chunk (last assistant text + terminating `result`
    // line) reaches the 'data' handler above, which raced this fallback into
    // firing first and dropping the real chat:run:complete behind the
    // terminalSent latch.
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      clearTimeout(warnTimer);
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
 *
 * @returns {Promise<void>} resolves once the cancelled run has fully settled
 *   (i.e. its terminal IPC event has fired) — or immediately for a waiting/
 *   no-op cancel, since there is nothing further to await in those cases.
 */
function cancel(tabId) {
  const entry = inFlight.get(tabId);
  if (entry) {
    entry.cancelFn(); // settle() (on child exit) deletes from inFlight + pumps the next run
    return entry.donePromise || Promise.resolve();
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
  return Promise.resolve();
}

// ─── External-caller entry point (PRD 753) ─────────────────────────────────
// Pushes a prompt into an already-open tab's chat queue from outside the
// renderer — Web Remote, the admin HTTP route, or the scheduler MCP tool.
// Fire-and-forget over IPC: the renderer-side listener (chat.ts) resolves
// the tab's live sessionId/cwd from useSessions and calls useChat.send()
// directly, reusing send()'s existing queued-vs-immediate branching rather
// than duplicating it here.

function enqueueExternalPrompt(tabId, prompt) {
  broadcast('chat:external-send', { tabId, prompt });
}

/**
 * Registers the admin-HTTP entry point for enqueueExternalPrompt, mirroring
 * prdCreate.cjs's registerAdminRoute pattern (auth is the injected transport's
 * job; this only owns route logic + body parsing).
 */
function registerAdminRoute(adminHttp) {
  const { readBody, sendJson } = require('./lib/localAdminHttp.cjs');
  const { schemas } = require('./ipcSchemas.cjs');

  adminHttp.registerRoute('POST', '/admin/chat/send-prompt', async (req, res) => {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    let body;
    try {
      body = schemas.chatExternalSend.parse(parsed);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.message ?? 'invalid body' });
      return;
    }
    enqueueExternalPrompt(body.tabId, body.prompt);
    sendJson(res, 200, { ok: true });
  });
}

// ─── IPC handler registration ─────────────────────────────────────────────

function registerChatHandlers() {
  const { schemas, validated } = require('./ipcSchemas.cjs');

  ipcMain.handle('chat:run', validated(schemas.chatRun, async ({ tabId, sessionId, prompt, cwd, resume, promptId }) => {
    run({ tabId, sessionId, prompt, cwd, resume: !!resume, promptId });
    return { ok: true };
  }));

  // Classification for a queued PromptTicket reaching the front of its
  // per-tab queue (PRD 749) — a direct bounded call, never a scheduler job
  // (see classifyPromptTicket.cjs's docblock for why that would be circular).
  ipcMain.handle('chat:classify-ticket', validated(schemas.chatClassifyTicket, async ({ text }) => {
    return classifyPromptTicket(text);
  }));

  ipcMain.handle('chat:cancel', async (_e, payload) => {
    let tabId;
    try { tabId = schemas.chatCancel.parse(payload).tabId; } catch { return; }
    await cancel(tabId);
  });

  ipcMain.handle('chat:probe-context', validated(schemas.chatProbeContext, async ({ tabId, sessionId, cwd }) => {
    probeContextUsage({ tabId, sessionId, cwd });
    return { ok: true };
  }));
}

module.exports = {
  run,
  cancel,
  attachWindow,
  registerChatHandlers,
  parseStopSignal,
  splitStopSignal,
  parseContextUsageMarkdown,
  probeContextUsage,
  STOP_SENTINEL,
  CHAT_MODE_TRUTH_INSTRUCTION,
  KILL_CEILING_MS,
  KILL_CEILING_MIN,
  WARN_CEILING_MS,
  __setExecutor,
  enqueueExternalPrompt,
  registerAdminRoute,
};
