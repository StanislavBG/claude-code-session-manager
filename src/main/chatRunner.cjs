'use strict';
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

/**
 * chatRunner.cjs — headless `claude -p --output-format stream-json` runner for
 * the terminal chat UI (PRD 319). Each call spawns a fresh process that exits
 * when done; no idle process lives between commands.
 *
 * Runs (silent and manual) go through one FIFO queue gated only by the shared
 * sessionSlots pool; there is no chat-private concurrency cap.
 *
 * Public surface:
 *   run({ tabId, sessionId, prompt, cwd, resume, silent }): void  — fire-and-forget enqueue.
 *     Both silent (PRD 470) and manual runs go through the same FIFO queue.
 *     Silent runs additionally suppress the six turn-affecting broadcasts + recordExchange.
 *   cancel(tabId): Promise<void>  — resolves once the cancelled run fully settles
 *   parseStopSignal(finalText): { questions: string[] } | null     — exported for reuse
 *   parseContextUsageMarkdown(text): { usedTokens, totalTokens, usedPct, categories } | null
 *                                                                    — pure parser for `/context`
 *   STOP_SENTINEL: string                                           — exported for tests
 *   __setExecutor(fn): void                                         — test seam
 *   recordNeedsInput / recordAnswerIfOpen                           — Epic event log: job.needs_input
 *                                                                    on a stop-signal turn, human.answer on the reply
 *
 * IPC events broadcast to the renderer:
 *   chat:run:queued     { tabId, sessionId, position }   — waiting behind a busy lane
 *   chat:run:started    { tabId, sessionId }
 *   chat:run:output     { tabId, delta }
 *   chat:run:tool-use   { tabId, id, kind, label, detail }
 *   chat:run:complete   { tabId, sessionId, finalMessage }
 *   chat:run:needs-input { tabId, sessionId, questions, raw }
 *   chat:run:error      { tabId, sessionId, message }
 *                         — the kill-ceiling variant additionally carries
 *                           { elapsedMs, ceilingMs, lastToolUses } so a resumed
 *                           turn can tell whether an external side effect
 *                           landed before verifying/retrying
 *   chat:run:notice     { tabId, sessionId, message }        — informational, not terminal
 *                         (also fires at 80% of the kill ceiling as a wrap-up nudge)
 */

const { spawn } = require('node:child_process');
const { ipcMain } = require('electron');
const { resolveClaudeBin, claudeSpawnTarget } = require('./lib/claude/claudeBin.cjs');
const { cleanChildEnv, pathWithUserBins, assertNoCredentials } = require('./lib/process/cleanEnv.cjs');
const { recordExchange, formatAskedResult } = require('./exchanges.cjs');
const { classifyToolUse, humanMessageSummary } = require('./lib/toolUseClassify.cjs');
const { extractJson } = require('./lib/util/extractJson.cjs');
const { classifyPromptTicket } = require('./lib/classifyPromptTicket.cjs');
const sessionSlots = require('./lib/scheduler/sessionSlots.cjs');
const opsErrorLog = require('./lib/telemetry/opsErrorLog.cjs');
const telemetryCounters = require('./lib/telemetry/telemetryCounters.cjs');
const { killTree, detachedSpawnOpts } = require('./lib/process/killTree.cjs');
const agentModelResolve = require('./lib/claude/agentModelResolve.cjs');
const { developLoopOffSettingsArgs } = require('./lib/epic/developLoopSpawn.cjs');
// Called through the module object (not destructured) so tests can inject a catalog.
const packSpawnArgs = require('./lib/packs/packSpawnArgs.cjs');
const { resolveEpicEffort, effortArgs } = require('./lib/claude/agentEffortResolve.cjs');
const { planEpicSpawn, resolveEpicTurnModel } = require('./lib/epic/epicSpawnPlan.cjs');
const { buildPersonaToolScope, personaToolScopeArgs, skillDenyArgs, HEADLESS_SCOPE_AGENT_NAME, CHAT_HARNESS_MCP_SERVERS } = require('./lib/claude/personaToolScope.cjs');
const epicWorktreeMint = require('./lib/epic/epicWorktreeMint.cjs');
const epicDepsSync = require('./lib/epic/epicDepsSync.cjs');
const logs = require('./logs.cjs');
const chatInflight = require('./lib/chatInflight.cjs');
const { feedChildStdin } = require('./lib/process/childStdin.cjs');
const memoryScope = require('./lib/process/memoryScope.cjs');
const { createHeadTailBuffer } = require('./lib/util/headTailBuffer.cjs');
const { isNonClaudeAgentCli } = require('./lib/agent-cli/agentCliEvents.cjs');
const { planAgentCliTurn } = require('./lib/agent-cli/agentCliTurn.cjs');
const { writeNativeSession } = require('./lib/agent-cli/agentCliSessionStore.cjs');
// Module object (not destructured) so tests can stub the append.
const epicEventLog = require('./lib/epic/epicEventLog.cjs');
const artifactStore = require('./lib/epic/artifactStore.cjs');
const { postArtifactReadyNotice } = require('./lib/epic/artifactNotice.cjs');

// Caps on per-run stream buffers (a run can last hours).
const STDERR_TAIL_MAX = 64 * 1024;
const LINE_BUFFER_MAX = 8 * 1024 * 1024;

// The only two CLI errors that mean "wrong session flag" (verified against the
// real CLI). "in use" → the transcript exists, so resume; "no conversation" →
// nothing to resume, so create. Never widen this into a general retry.
const SESSION_IN_USE_RE = /Session ID .* is already in use/i;
const NO_CONVERSATION_RE = /No conversation found with session ID/i;

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

// Replaces STOP_SIGNAL_INSTRUCTION for turns the scheduler itself starts: no human is
// watching, so a question would stall the Epic forever.
const SCHEDULER_TURN_INSTRUCTION =
  `IMPORTANT: This turn was started by the scheduler and nobody is watching. ` +
  `Never ask questions and never print ${STOP_SENTINEL}. Act on the message below with ` +
  `the /develop skill's Phase 2 rules (reset, fix the spec, archive, or queue a fix wave). ` +
  `Give everything left open an outcome (queue, decide, schedule or close it), and end ` +
  `with a short report of what you did.\n\n`;

/**
 * Picks the instruction block that opens a turn: scheduler turns and
 * auto-started inbound Epics have no human watching, so they never ask.
 */
/** Only the first (inbound-proposal) turn earns a follow-up; scheduler turns never chain. */
function shouldFollowUp(origin) {
  return origin === 'inbound-proposal';
}

function turnInstructionFor(origin, cwd, sessionId) {
  if (origin === 'scheduler') {
    // An auto-started Epic with no PRDs needs /develop Phase 1 (plan), not Phase 2.
    const auto = require('./lib/feedback-remote/autoStartedSession.cjs');
    if (auto.autoStartNeedsPlan(cwd, sessionId)) return auto.autoStartTurnInstruction(STOP_SENTINEL);
    return SCHEDULER_TURN_INSTRUCTION;
  }
  if (origin === 'inbound-proposal') {
    const auto = require('./lib/feedback-remote/autoStartedSession.cjs');
    if (auto.isAutoStartedEpic(cwd, sessionId)) return auto.autoStartTurnInstruction(STOP_SENTINEL);
  }
  return STOP_SIGNAL_INSTRUCTION;
}

// tab+prompt keys of scheduler-originated prompts awaiting their run() (consumed once).
const schedulerPrompts = new Map();
const SCHEDULER_PROMPT_TTL_MS = 6 * 60 * 60 * 1000;
function noteSchedulerPrompt(tabId, prompt) {
  const now = Date.now();
  for (const [k, v] of schedulerPrompts) if (v.expires < now) schedulerPrompts.delete(k);
  const key = `${tabId}\n${prompt}`;
  const cur = schedulerPrompts.get(key);
  schedulerPrompts.set(key, { count: (cur ? cur.count : 0) + 1, expires: now + SCHEDULER_PROMPT_TTL_MS });
}
function consumeSchedulerPrompt(tabId, prompt) {
  const key = `${tabId}\n${prompt}`;
  const cur = schedulerPrompts.get(key);
  if (!cur || cur.expires < Date.now()) { schedulerPrompts.delete(key); return false; }
  if (cur.count <= 1) schedulerPrompts.delete(key); else cur.count -= 1;
  return true;
}

// ─── Hard wall-clock kill ceiling ────────────────────────────────────────
// Defined here (ahead of the relay-note TTL and CHAT_MODE_TRUTH_INSTRUCTION) so
// the relay TTL and the prompt's stated budget are always derived from this
// single constant — never a hand-written duplicate that could drift from the
// real timer below.
const KILL_CEILING_MS = 30 * 60 * 1000; // 30 minutes
const KILL_CEILING_MIN = KILL_CEILING_MS / 60_000;
// 80% warning point — gives the model a turn-visible nudge to wrap up before
// the hard kill fires at 100%. Not configurable; see PRD out-of-scope note
// re: making KILL_CEILING_MS itself configurable.
const WARN_CEILING_MS = Math.floor(KILL_CEILING_MS * 0.8);

// tab+prompt keys of relayed external sends (Web Remote phone / admin API) awaiting
// their run(): each entry is a FIFO of relay names, consumed once per EXTERNAL run.
// A note only lives as long as its send can still produce a run: the ack window,
// plus the time a 'queued' send waits for the in-flight turn ahead of it (bounded by
// the kill ceiling). A send that resolves without a run drops its note at once.
const EXTERNAL_RELAYS = new Set(['web-remote', 'admin-api']);
const relayPrompts = new Map();
const EXTERNAL_SEND_ACK_TIMEOUT_MS = 8000;
const RELAY_RUN_START_WINDOW_MS = KILL_CEILING_MS;
const RELAY_PROMPT_TTL_MS = EXTERNAL_SEND_ACK_TIMEOUT_MS + RELAY_RUN_START_WINDOW_MS;
function noteRelayPrompt(tabId, prompt, relay) {
  if (!EXTERNAL_RELAYS.has(relay)) return null;
  const now = Date.now();
  for (const [k, v] of relayPrompts) {
    const live = v.filter((e) => e.expires >= now);
    if (live.length) relayPrompts.set(k, live); else relayPrompts.delete(k);
  }
  const key = `${tabId}\n${prompt}`;
  const list = relayPrompts.get(key) || [];
  const entry = { relay, expires: now + RELAY_PROMPT_TTL_MS };
  list.push(entry);
  relayPrompts.set(key, list);
  return entry;
}
// Removes exactly one send's note (by identity) — a same-text note of another send stays.
function dropRelayPrompt(tabId, prompt, entry) {
  const key = `${tabId}\n${prompt}`;
  const list = relayPrompts.get(key);
  if (!list) return;
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) relayPrompts.delete(key);
}
function relayNoteCount(tabId, prompt) {
  const now = Date.now();
  return (relayPrompts.get(`${tabId}\n${prompt}`) || []).filter((e) => e.expires >= now).length;
}
function consumeRelayPrompt(tabId, prompt) {
  const key = `${tabId}\n${prompt}`;
  const list = relayPrompts.get(key);
  if (!list) return null;
  const now = Date.now();
  let hit = null;
  while (list.length && !hit) {
    const e = list.shift();
    if (e.expires >= now) hit = e.relay;
  }
  if (!list.length) relayPrompts.delete(key);
  return hit;
}

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
  `report exactly what landed, and queue or schedule what remains; only a step ` +
  `that needs the human goes back to them. End this turn with ` +
  `either a real result or an explicit statement that the user needs to ` +
  `reply for the work to continue.\n\n`;

// ─── Run queue ──────────────────────────────────────────────────────────────
// FIFO lane for ALL runs (silent probes and manual sends). There is NO private
// cap: a queued run starts exactly when lib/scheduler/sessionSlots.cjs grants a
// slot — the sole machine-wide cap.

// tabId → { cancelFn, donePromise } for every ACTIVE run; FIFO list of WAITING
// runs; live count. `donePromise` resolves once the run's own executeRun()
// promise settles (i.e. after settle() runs for that tabId) — attached right
// after the executor is invoked (see run()/pump()) so cancel() callers can
// await full teardown instead of firing SIGTERM and returning immediately.
const inFlight = new Map();
const waiting = []; // [{ tabId, sessionId, prompt, cwd, resume, silent, onSilentResult, onSilentError }]
// tabIds picked by pump() but not yet registered in `inFlight` by executeRun.
// Closes the microtask-wide window in which per-tab exclusivity would
// otherwise not hold. See pump().
const dispatching = new Set();
// sessionIds with a live CLI child: added when pump() dispatches a run, dropped
// in the same .finally() that frees the lane — i.e. only after executeRun has
// settled from `close`/`error`/spawn failure. A cancelled child still exiting
// therefore keeps holding it. Two `claude -p` against one sessionId die with
// "Session ID … is already in use", so pump() refuses to start a second run
// for a held sessionId (it waits in `waiting` like any other blocked run).
const liveSessions = new Set();
// sessionIds whose previous-boot CLI child is still alive (chatBootRecovery): run() for
// them waits in `waiting` until released, so a second writer is never spawned.
const orphanSessions = new Set();
function holdOrphanSession(sessionId) { if (sessionId) orphanSessions.add(sessionId); }
function releaseOrphanSession(sessionId) { orphanSessions.delete(sessionId); pump(); }
// Submissions parked while a New Epic's fire-and-forget worktree mint is still in
// flight (tabId → opts). Counted by run()'s tabBusy; cancel() can drop them.
const pendingStart = new Map();

// ─── Epic event log: questions and answers ────────────────────────────────
// An Epic chat's sessionId IS its Epic id (EPIC : CLI session = 1:1). A run
// that ends on the stop signal appends job.needs_input (Epic-level: no slug)
// with the parsed questions; the next human-sent prompt on that session is
// the answer and appends human.answer. Fire-and-forget: an event-log failure
// never breaks a chat turn.

/** sessionId → { cwd, questions } for a question still waiting on a human. */
const openQuestions = new Map();

function appendChatEpicEvent(cwd, epicId, event) {
  if (typeof cwd !== 'string' || !cwd || typeof epicId !== 'string' || !epicId) return Promise.resolve(null);
  let p;
  try {
    p = epicEventLog.appendEpicEvent(cwd, epicId, event);
  } catch (err) {
    p = Promise.reject(err);
  }
  return Promise.resolve(p).catch((err) => {
    console.error('[chatRunner] epic event append failed', event?.kind, err?.message ?? err);
    return null;
  });
}

/**
 * Poke the Epic outside-state emitter (lib/epic/epicStateEmitter.cjs) at a
 * turn's acceptance and settle — the only moments that time the 'working' and
 * 'needs_input' outside states. Lazy require; never throws, never alters a turn.
 */
function pokeState(cwd, sessionId) {
  if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string' || !sessionId) return;
  try {
    require('./lib/epic/epicStateEmitter.cjs').pokeEpicState(cwd, sessionId);
  } catch (err) {
    console.error('[chatRunner] epic state poke failed', sessionId, err?.message ?? err);
  }
}

/** Staging folder for a chat session's artifacts, or null (unsafe id / mkdir failure — logged). */
function chatArtifactsDir(sessionId) {
  try {
    return artifactStore.stagingDirFor({ runId: sessionId });
  } catch (err) {
    console.error('[chatRunner] artifact staging dir unavailable', sessionId, err?.message ?? err);
    return null;
  }
}

/**
 * Ingest a finished turn's staging folder into artifacts/<epic-id>/. An Epic chat's sessionId IS
 * its Epic id. Fire-and-forget: errors and skipped files are logged, never thrown.
 */
function ingestChatArtifacts({ cwd, sessionId, srcDir }) {
  let p;
  try {
    p = artifactStore.ingestDir({ projectRoot: cwd, epicId: sessionId, srcDir, producer: { epicId: sessionId, sessionId } });
  } catch (err) {
    p = Promise.reject(err);
  }
  return Promise.resolve(p).then(async (res) => {
    for (const s of res?.skipped || []) console.error('[chatRunner] artifact not ingested', s.path, s.reason);
    // One 'artifact-ready' notice per ingest batch, only when something landed (never throws).
    if (res && Array.isArray(res.published) && res.published.length > 0) {
      await postArtifactReadyNotice({ cwd, epicId: sessionId, entries: res.published });
    }
    return res;
  }).catch((err) => {
    console.error('[chatRunner] artifact ingest failed', sessionId, err?.message ?? err);
    return null;
  });
}

/**
 * Append job.needs_input for an Epic chat turn that asked questions and
 * remember them so the next human prompt is recorded as the answer.
 * @param {{ cwd: string, sessionId: string, questions: string[], answerBody?: string }} args
 */
function recordNeedsInput({ cwd, sessionId, questions, answerBody }) {
  const qs = Array.isArray(questions) ? questions.filter((q) => typeof q === 'string') : [];
  openQuestions.set(sessionId, { cwd, questions: qs });
  return appendChatEpicEvent(cwd, sessionId, {
    kind: 'job.needs_input',
    source: 'chat',
    sessionId,
    questions: qs,
    ...(typeof answerBody === 'string' && answerBody ? { answerBody } : {}),
  });
}

/**
 * Append human.answer when a human-sent prompt answers this session's open
 * questions. Scheduler-originated prompts are not answers (the question stays
 * open). Returns the append promise, or null when nothing was open.
 * @param {{ cwd?: string, sessionId: string, prompt: string, origin?: string }} args
 */
function recordAnswerIfOpen({ cwd, sessionId, prompt, origin }) {
  const open = openQuestions.get(sessionId);
  if (!open || origin === 'scheduler') return null;
  openQuestions.delete(sessionId);
  return appendChatEpicEvent(cwd || open.cwd, sessionId, {
    kind: 'human.answer',
    source: 'chat',
    sessionId,
    questions: open.questions,
    answer: typeof prompt === 'string' ? prompt : '',
  });
}

/**
 * Append the message event for a prompt on an Epic chat (sessionId = Epic id):
 * - origin 'human' (a desktop composer submit) → human.message { via: 'desktop' };
 * - origin 'external' tagged relay 'web-remote' (the paired phone) → human.message { via: 'web-remote' };
 * - origin 'external' tagged relay 'admin-api' (POST /admin/chat/send-prompt, which
 *   agents also call) → external.message { via: 'admin-api' }.
 * The relay tag is noted by enqueueExternalPrompt and consumed once by run().
 * Untagged external, 'scheduler', 'inbound-proposal', no origin and a boot-recovery
 * re-send (chatBootRecovery.cjs stamps bootRecovery: true) log nothing. This is the
 * event log only — the auto-approval human-prompt ledger (noteChatRunOrigin) still
 * counts origin 'human' alone. Fire-and-forget; a failure is logged by
 * appendChatEpicEvent, never thrown.
 * @param {{ cwd?: string, sessionId: string, prompt: string, origin?: string, bootRecovery?: boolean, relay?: string | null }} args
 */
function recordHumanMessage({ cwd, sessionId, prompt, origin, bootRecovery, relay }) {
  if (bootRecovery === true) return null;
  let kind; let via;
  if (origin === 'human') { kind = 'human.message'; via = 'desktop'; }
  else if (origin === 'external' && relay === 'web-remote') { kind = 'human.message'; via = 'web-remote'; }
  else if (origin === 'external' && relay === 'admin-api') { kind = 'external.message'; via = 'admin-api'; }
  else return null;
  let summary;
  try { summary = humanMessageSummary(prompt); } catch { return null; }
  return appendChatEpicEvent(cwd, sessionId, { kind, source: 'chat', sessionId, via, ...summary });
}

// Indirection so tests can stub the spawn without launching claude.
let executor = executeRun;
function __setExecutor(fn) { executor = fn || executeRun; }

/**
 * Test hook: drop all lane state. The module is a singleton shared across
 * every test in a file, and a spec whose fake child never emits 'exit' leaves
 * its run permanently in flight — holding a session slot and a lane seat that
 * silently starve every later test. Also releases the shared slot pool.
 */
function __resetQueueForTests() {
  inFlight.clear();
  dispatching.clear();
  liveSessions.clear();
  orphanSessions.clear();
  waiting.length = 0;
  pendingStart.clear();
  openQuestions.clear();
  relayPrompts.clear();
  sessionSlots.__resetForTests();
}

// ─── Window reference (set by attachWindow) ────────────────────────────────

let mainWindow = null;

function attachWindow(win) { mainWindow = win; }

function broadcast(channel, payload) {
  sendIfAlive(mainWindow, channel, payload);
}

// ─── Public queue entry ─────────────────────────────────────────────────────

/**
 * Enqueue a chat run for a tab. Fire-and-forget — results arrive via IPC.
 * Both silent (automated probe) and manual (user-initiated) runs share the
 * FIFO lane — submits beyond the free slots queue and are
 * announced via chat:run:queued (silent runs stay invisible to the renderer;
 * see pump() below). De-dupes a tab already in the pipeline (the renderer's
 * per-tab prompt queue in chat.ts only ever calls this once per tab at a
 * time, but the guard holds regardless).
 *
 * @param {{ tabId: string, sessionId: string, prompt: string, cwd: string, resume: boolean, silent?: boolean, onSilentResult?: (text: string) => void, onSilentError?: (message: string, code?: string) => void, promptId?: string }} opts
 */
function run(opts) {
  // A scheduler-originated prompt (tagged by enqueueExternalPrompt) is re-identified
  // here by tab + exact text, since it travels through the renderer's chat:run.
  if (!opts.silent && consumeSchedulerPrompt(opts.tabId, opts.prompt)) opts = { ...opts, origin: 'scheduler' };
  // A relayed external send (Web Remote / admin API) is re-identified the same way;
  // the relay only picks the event-log kind, never the origin. Only an external run
  // takes a note: a same-text desktop prompt must not steal a queued phone send's tag.
  if (!opts.silent && opts.origin === 'external' && opts.relay === undefined) opts = { ...opts, relay: consumeRelayPrompt(opts.tabId, opts.prompt) };
  // Per-tab exclusivity still holds — two `claude -p --resume` against ONE
  // sessionId must never overlap — but it is now enforced in pump() (which
  // refuses to start a run for a tab that already has one live) rather than by
  // discarding the submission here.
  //
  // Dropping was silent and unrecoverable: `chat:run` still resolved
  // { ok: true }, so the renderer sat at running: true forever with no toast
  // and no terminal event. A `silent` /context probe holding the tabId was
  // enough to swallow a user's message. User-initiated sends are now QUEUED
  // behind whatever holds the tab and dispatched in FIFO order.
  // `dispatching` counts as busy too: between pump() picking a run and
  // executeRun registering it in `inFlight`, the tab is committed but not yet
  // visible in `inFlight` — the same window pump() guards against.
  const tabBusy = inFlight.has(opts.tabId)
    || dispatching.has(opts.tabId)
    || liveSessions.has(opts.sessionId)
    || orphanSessions.has(opts.sessionId)
    || pendingStart.has(opts.tabId)
    || waiting.some((w) => w.tabId === opts.tabId);
  if (tabBusy && opts.silent) {
    // Silent probes stay best-effort and invisible: a probe that collides is
    // still dropped, since queueing one would delay real work to no benefit.
    return { accepted: false, reason: 'tab-busy-silent' };
  }
  // A human prompt sent after a needs-input turn is that question's answer.
  if (!opts.silent) recordAnswerIfOpen(opts);
  // Once per prompt: the held-for-worktree re-entry below carries the mark.
  if (!opts.silent && !opts.humanMessageRecorded) {
    recordHumanMessage(opts);
    opts = { ...opts, humanMessageRecorded: true };
  }

  // A New Epic's turn 1 races the fire-and-forget worktree mint: only when a mint is
  // actually in flight for this Epic, hold the submission (<=90s, never rejects) so the
  // first spawn lands in the worktree. Every other run is untouched.
  if (epicWorktreeMint.hasPendingEpicWorktree(opts.cwd, opts.tabId)) {
    pendingStart.set(opts.tabId, opts);
    epicWorktreeMint.awaitPendingEpicWorktree(opts.cwd, opts.tabId)
      .then((wt) => wt, () => null)
      .then((wt) => {
        if (pendingStart.get(opts.tabId) !== opts) return; // cancelled meanwhile
        pendingStart.delete(opts.tabId);
        run({ ...opts, worktreeDirHint: wt && wt.dir ? wt.dir : undefined });
      });
    if (!opts.silent) pokeState(opts.cwd, opts.sessionId);
    return { accepted: true, queued: tabBusy };
  }

  waiting.push(opts);
  pump();
  if (!opts.silent) pokeState(opts.cwd, opts.sessionId);
  return { accepted: true, queued: tabBusy };
}

// Start queued runs FIFO while sessionSlots grants a slot, then announce queue positions for
// the remainder. O(n) over the waiting list (bounded by open tabs).
function pump() {
  while (waiting.length > 0) {
    // Per-tab exclusivity: skip past any waiting run whose tab already has one
    // live, rather than head-blocking the whole lane on it. `dispatching`
    // covers the gap between picking a job here and executeRun() registering
    // it in `inFlight` (which happens a microtask later) — without it, one
    // synchronous sweep of this loop could start two runs for the same tab and
    // race two --resume processes against a single sessionId.
    const idx = waiting.findIndex((w) => !inFlight.has(w.tabId) && !dispatching.has(w.tabId)
      && !liveSessions.has(w.sessionId) && !orphanSessions.has(w.sessionId));
    // Everything queued is blocked behind its own tab's live run; the settle()
    // of that run re-pumps.
    if (idx === -1) break;
    // Capacity comes only from the Session-Manager-wide slot pool shared with
    // the scheduler (lib/scheduler/sessionSlots.cjs). Refusal → stop; the rest
    // stay queued in order and the next release in either subsystem re-pumps.
    const slotToken = sessionSlots.acquire(`chat:${waiting[idx].tabId}`);
    if (!slotToken) break;
    const [job] = waiting.splice(idx, 1);
    dispatching.add(job.tabId);
    liveSessions.add(job.sessionId);
    Promise.resolve()
      .then(() => {
        const donePromise = executor(job);
        const entry = inFlight.get(job.tabId);
        if (entry) entry.donePromise = donePromise;
        return donePromise;
      })
      .catch(() => { /* executeRun never rejects; defensive */ })
      .finally(() => {
        dispatching.delete(job.tabId);
        liveSessions.delete(job.sessionId);
        sessionSlots.release(slotToken);
        pump();
        if (!job.silent) pokeState(job.cwd, job.sessionId);
      });
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
 * @param {{ tabId: string, sessionId: string, prompt: string, cwd: string, resume: boolean, silent?: boolean, onSilentResult?: (text: string) => void, onSilentError?: (message: string, code?: string) => void, promptId?: string }} opts
 * @returns {Promise<void>}
 */
function executeRun({ tabId, sessionId, prompt, cwd, resume, silent, onSilentResult, onSilentError, promptId, origin, worktreeDirHint }) {
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
      chatInflight.end(sessionId).catch(() => {});
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
    let lineOverflowLogged = false;
    const emitTerminal = (channel, payload, diag = {}) => {
      if (terminalSent) return;
      terminalSent = true;
      // Every terminal error for this tab, logged once, regardless of the
      // `silent` gate below — a probe run's failure is still real signal for
      // tracing even though it never reaches the visible chat UI.
      if (channel === 'chat:run:error') {
        opsErrorLog.appendError({
          cwd,
          scope: 'chatRunner',
          level: diag.level || 'error',
          code: diag.code || payload?.code,
          tabId,
          tags: silent ? ['silent-probe'] : [],
          message: payload?.message ?? 'chat run failed',
          meta: { sessionId, silent },
        });
      }
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

    // Non-Claude agent-CLI Epic (codex, gemini, …): the turn spawns that CLI's adapter command
    // instead of claude; every Claude-only resolution below is skipped for it.
    let agentEpic = null;
    try { agentEpic = agentModelResolve.findEpicByClaudeSessionId(cwd, sessionId); } catch { agentEpic = null; }
    const isAgentCli = !!(agentEpic && isNonClaudeAgentCli(agentEpic.agentCli));

    const claudeBin = isAgentCli ? null : resolveClaudeBin();
    // Carried down to any MCP server this run spawns (e.g.
    // scripts/scheduler-mcp-server.cjs, inherited via the claude CLI's own
    // child env) so scheduler_create_prd can auto-resolve sourcePromptId
    // when the model forgets to pass it — see prdCreate.cjs's
    // resolveSourcePromptIdFromClaudeSession. sessionId IS the Epic's
    // claudeSessionId for an Epic-backed tab (domain model: Epic:claude-session
    // 1:1); for a non-Epic tab, resolution below simply finds no match.
    // SM_PROJECT_ROOT is the real project cwd (never the worktree spawn cwd
    // resolved below) — scheduler-mcp-server.cjs forwards it as
    // originProjectRoot on create-prd/open-session/readiness calls so those
    // routes can resolve the right project even from a worktree pwd. See
    // projectRootResolve.cjs.
    // SM_ARTIFACTS_DIR: a per-session staging folder OUTSIDE the repo (artifactStore.stagingDirFor);
    // whatever the agent writes there is ingested into the Artifacts store when the turn closes
    // (ingestChatArtifacts below), so it shows in the File Explorer with no merge. runId = sessionId,
    // the same folder the Epic's Terminal view gets (pty.cjs) — EPIC : CLI session = 1:1.
    const artifactsDir = chatArtifactsDir(sessionId);
    const artifactsEnv = artifactsDir ? { SM_ARTIFACTS_DIR: artifactsDir } : {};
    const childEnv = cleanChildEnv({ PATH: pathWithUserBins(), SM_CHAT_SESSION_ID: sessionId, SM_PROJECT_ROOT: cwd, ...artifactsEnv });

    // Prepend the stop-signal protocol instruction and the chat-mode truth
    // instruction to every prompt
    const fullPrompt = turnInstructionFor(origin, cwd, sessionId)
      + CHAT_MODE_TRUTH_INSTRUCTION + prompt;

    // sessionId is the Epic's claudeSessionId for an Epic-backed tab (see
    // comment above childEnv) — resolve that Epic's agentType persona model,
    // project-overlay-then-global (agentModelResolve.cjs's
    // readOverlayAwarePersonaModel). Terminal (EpicTerminalPane.tsx) calls
    // this SAME function via the agents:resolve-epic-model IPC, so the two
    // views of one Epic agree by construction, not by convention. Never
    // throws; falls back to the hardcoded 'sonnet' literal when there's no
    // Epic, no agentType, or the persona has no model/'inherit' — --model
    // must never be left unpinned (CLAUDE.md model-pinning rule).
    // A pinned Epic (agentSnapshotId, epicSpawnPlan.cjs's resolveEpicTurnModel) takes its model
    // from the AgentSnapshot frozen at mint, so a later persona edit never reaches it.
    const model = isAgentCli ? null : resolveEpicTurnModel({ cwd, claudeSessionId: sessionId });
    // Persona `effort:` (same overlay-aware persona, agentEffortResolve.cjs);
    // effortArgs() yields NO tokens for inherit/absent/dangling.
    const effortFlags = isAgentCli ? [] : effortArgs(resolveEpicEffort({ cwd, claudeSessionId: sessionId }).effort);

    // Develop-loop-off Epics launch with the dev plugin disabled for this session only.
    // The Epic's selected context packs ride every turn: --plugin-dir per pack + their laws
    // via --append-system-prompt (each turn is a fresh process, so every turn must carry them).
    let loopOffArgs = [];
    /** @type {string[]} */ let packPluginDirArgs = [];
    let packLaws = '';
    if (!isAgentCli) {
      try {
        const epic = agentModelResolve.findEpicByClaudeSessionId(cwd, sessionId);
        loopOffArgs = developLoopOffSettingsArgs(epic);
        const packArgs = packSpawnArgs.composePackSpawnArgs({ packIds: epic?.packs });
        packPluginDirArgs = Array.isArray(packArgs.pluginDirArgs) ? packArgs.pluginDirArgs : [];
        packLaws = typeof packArgs.laws === 'string' ? packArgs.laws : '';
      } catch (e) {
        // Lookup or compose failure: launch without packs (loop-off args kept if already resolved).
        packPluginDirArgs = [];
        packLaws = '';
        try {
          logs.writeLine({
            scope: 'chatRunner',
            level: 'warn',
            message: `context packs skipped for this turn: ${/** @type {Error} */ (e)?.message || String(e)}`,
            meta: { tabId, sessionId },
          });
        } catch { /* logging must never fail a turn */ }
      }
    }

    // Main is authoritative about --resume vs --session-id AND the spawn cwd, and it decides
    // them TOGETHER (epicSpawnPlan.cjs): a transcript under an encoding the spawn cwd cannot see
    // must never yield a claimed flag. Unreachable / closed Epics are refused before any spawn.
    const plan = planEpicSpawn({ cwd, claudeSessionId: sessionId, fallbackResume: !!resume, worktreeDirHint });
    if (!plan.ok) {
      emitTerminal('chat:run:error', { tabId, sessionId, code: plan.code, message: plan.message });
      // emitTerminal is a no-op broadcast for silent runs, so hand the refusal to the caller
      // directly — otherwise it waits out its own timeout and reports a generic one.
      if (silent && typeof onSilentError === 'function') {
        try { onSilentError(plan.message, plan.code); } catch { /* caller bug must not wedge the lane */ }
      }
      settle();
      return;
    }
    // Long-lived Epic worktree: refresh its node_modules links from the project checkout
    // (fire-and-forget, throttled). The sync runs after the CLI is spawned, so it normally
    // lands before the agent's first tool call but is not awaited; the next turn guarantees it.
    if (plan.execCwd && plan.execCwd !== cwd) {
      epicDepsSync.syncEpicWorktreeDeps({ projectCwd: cwd, worktreeCwd: plan.execCwd });
    }
    // Agent-CLI turn plan (agentCliTurn.cjs): command, argv, stdin, auth env, parser, transcript.
    let agentPlan = null;
    if (isAgentCli) {
      agentPlan = planAgentCliTurn({ epic: agentEpic, claudeSessionId: sessionId, cwd: plan.execCwd, prompt: fullPrompt });
      if (!agentPlan.ok) {
        emitTerminal('chat:run:error', { tabId, sessionId, code: agentPlan.code, message: agentPlan.message });
        if (silent && typeof onSilentError === 'function') {
          try { onSilentError(agentPlan.message, agentPlan.code); } catch { /* caller bug must not wedge the lane */ }
        }
        settle();
        return;
      }
    }
    const agentEnv = agentPlan
      ? cleanChildEnv({ PATH: pathWithUserBins(), SM_CHAT_SESSION_ID: sessionId, SM_PROJECT_ROOT: cwd, ...artifactsEnv, ...agentPlan.envExtra })
      : null;

    // Gear binds chat (stamped snapshots only): same tool/MCP/pack/skill scope a job gets.
    let gearArgs = [];
    if (!isAgentCli && plan.persona && plan.persona.snapshot) {
      try {
        const gear = gearChatArgs({ snapshot: plan.persona.snapshot, cwd: plan.execCwd || cwd, projectRoot: cwd });
        gearArgs = gear.args;
        // Persona-declared packs load with the Epic's (as for jobs); known ones only.
        const snapPacks = (Array.isArray(plan.persona.snapshot.packs) ? plan.persona.snapshot.packs.map(String) : [])
          .filter((p) => !(agentEpic?.packs || []).map(String).includes(p));
        if (gear.args.length && snapPacks.length) {
          const extra = packSpawnArgs.composePackSpawnArgs({ packIds: snapPacks });
          packPluginDirArgs = [...packPluginDirArgs, ...(Array.isArray(extra.pluginDirArgs) ? extra.pluginDirArgs : [])];
          if (extra.laws) packLaws = packLaws ? `${packLaws}\n\n${extra.laws}` : extra.laws;
        }
        for (const message of gear.errors) {
          try {
            opsErrorLog.appendError({ cwd, scope: 'chatRunner', level: 'warn', code: 'capability_unknown', tabId, tags: [], message, meta: { sessionId } });
          } catch { /* logging must never fail a turn */ }
          if (!silent) broadcast('chat:run:notice', { tabId, sessionId, message });
        }
      } catch { gearArgs = []; }
    }

    const useResume = plan.useResume;
    if (!agentPlan && useResume !== !!resume) {
      try {
        logs.writeLine({
          scope: 'chatRunner',
          level: 'warn',
          message: `session flag mismatch: renderer resume=${!!resume}, main resume=${useResume}; transcript=${plan.transcriptPath ?? 'none'}`,
          meta: { tabId, sessionId, rendererResume: !!resume, mainResume: useResume, transcriptPath: plan.transcriptPath ?? null },
        });
      } catch { /* logging must never fail a turn */ }
    }

    // Build argv as an array — no shell: true, no string interpolation. Also
    // used for the flag-swap retry so both attempts share one construction path.
    const buildArgs = (resumeFlag) => {
      const a = [
        '-p',
        '--model', model,
        ...effortFlags,
        '--dangerously-skip-permissions',
        ...loopOffArgs,
        ...packPluginDirArgs,
        ...gearArgs,
        ...(packLaws ? ['--append-system-prompt', packLaws] : []),
        '--output-format', 'stream-json',
        '--verbose',
      ];
      // --resume carries the session context; no --session-id needed
      if (resumeFlag) a.push('--resume', sessionId);
      else a.push('--session-id', sessionId);
      return a;
    };

    if (!silent) broadcast('chat:run:started', { tabId, sessionId });

    // sessionId IS the Epic's claudeSessionId for an Epic-backed tab (see
    // comment above childEnv) — resolves to that Epic's isolated worktree
    // dir when one exists (PRD 1033), else `cwd` unchanged. `cwd` itself is
    // NEVER repointed: every ops-root/model/exchange resolution above and
    // below keeps using it exactly as before — only this ACTUAL spawn cwd
    // option does. See epicSpawnCwd.cjs's header comment (the ops-root
    // hazard) and jobWorktree.cjs's own (execCwd vs job.cwd) for why.
    const execCwd = plan.execCwd;

    let killed = false;
    let child = null;
    // session.open (surface 'chat') fires once per turn, only when a spawn
    // actually starts a brand-new CLI session (--session-id) — never for a
    // --resume turn, and never twice if the flag-swap retry re-spawns.
    let sessionOpenTracked = false;
    const doKill = (sig) => {
      if (killed) return;
      killed = true;
      if (!child) return;
      // Group kill on POSIX / taskkill /T on win32 (requires detachedSpawnOpts at spawn)
      if (!killTree(child.pid, sig)) { try { child.kill(sig); } catch { /* already dead */ } }
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
      }, { level: 'warn', code: 'ceiling-kill' });
      cancelFn();
    }, KILL_CEILING_MS);
    if (killTimer.unref) killTimer.unref();

    // One spawn of the CLI. Per-attempt state (buffers, child) lives in here;
    // everything turn-level (timers, latch, lane) is in the enclosing scope.
    const startAttempt = (resumeFlag, attemptNo) => {
    // Spawn with a stdin pipe: the prompt is fed on stdin (never argv — E2BIG
    // above 128 KB per argument on Linux, 8191 chars on Windows cmd.exe) and
    // feedChildStdin closes it, satisfying "claude -p stdin must be closed".
    // stdout is piped for real-time NDJSON streaming; stderr piped for
    // error-message capture.
    let thisChild;
    // Memory-capped systemd scope for this attempt (unwrapped when unsupported).
    // A turn's background processes (dev server, local service) outlive it on
    // purpose: the scope is never stopped; created --collect, systemd collects it once empty.
    try {
      const chatArgs = agentPlan ? agentPlan.args : buildArgs(resumeFlag);
      let target = agentPlan
        ? { command: agentPlan.command, args: chatArgs }
        : claudeSpawnTarget('chat', sessionId, claudeBin, chatArgs);
      // Limits first: with the cap off, never probe systemd.
      const limits = memoryScope.memoryLimitsFor({ totalRamMb: Math.floor(require('node:os').totalmem() / 1048576) });
      {
        if (limits && memoryScope.scopeSupported()) {
          const unit = `sm-chat-${memoryScope.sanitizeUnit(sessionId)}-${attemptNo}-${Date.now()}`;
          const wrapped = memoryScope.wrapInMemoryScope({
            command: target.command, args: target.args || chatArgs, unit, limits,
          });
          // argv0 cannot pass through systemd-run — dropped on the wrapped path only.
          target = { ...target, command: wrapped.command, args: wrapped.args, argv0: undefined };
        }
      }
      assertNoCredentials(agentPlan ? agentEnv : childEnv, { site: agentPlan ? 'chat-agent' : 'chat' });
      if (agentPlan) agentPlan.transcript.userPrompt(fullPrompt);
      thisChild = spawn(target.command, target.args || chatArgs, {
        ...(target.argv0 ? { argv0: target.argv0 } : {}),
        ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        cwd: execCwd,
        env: agentPlan ? agentEnv : childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...detachedSpawnOpts(), // own process group so killTree can SIGTERM descendants
      });
    } catch (err) {
      clearTimeout(killTimer);
      clearTimeout(warnTimer);
      emitTerminal('chat:run:error', {
        tabId,
        sessionId,
        message: `spawn failed: ${err?.message ?? String(err)}`,
      }, { code: 'spawn-failed' });
      settle();
      return;
    }
    child = thisChild;
    if (!agentPlan && !resumeFlag && !sessionOpenTracked) {
      sessionOpenTracked = true;
      telemetryCounters.trackSessionOpen({ surface: 'chat' });
    }
    chatInflight.begin(sessionId, { tabId, cwd, pid: thisChild.pid, startedAt, resume, silent, promptId, origin, worktreeDirHint }).catch(() => {});
    feedChildStdin(thisChild, agentPlan ? agentPlan.stdin : fullPrompt, {
      log: (m) => logs.writeLine({ scope: 'chatRunner', level: 'warn', message: m }),
    });

    // ─── Stream parsing ────────────────────────────────────────────────────
    // stdout is newline-delimited JSON (stream-json format). We buffer partial
    // lines across TCP/pipe chunks. O(output-size) in memory per run.

    // Per-attempt state — a retry starts from empty buffers.
    let lineBuffer = '';
    let finalAssistantText = '';
    const stderrBuffer = createHeadTailBuffer(STDERR_TAIL_MAX);

    const stderrText = () => stderrBuffer.matchText();

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
            const detail = describeToolUseInput(block);
            recentToolUses.push({ ...classified, detail });
            if (recentToolUses.length > RECENT_TOOL_USE_LIMIT) recentToolUses.shift();
            if (!silent) broadcast('chat:run:tool-use', { tabId, id: block.id, ...classified, detail });
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
            // the final text to whoever enqueued the probe.
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
              recordNeedsInput({ cwd, sessionId, questions: signal.questions, answerBody: signal.answerBody });
              // Record durable exchange off the hot path — UI must not wait on Haiku
              recordExchange({
                sessionId,
                cwd,
                prompt,
                result: formatAskedResult(signal.answerBody, signal.questions),
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
            if (shouldFollowUp(origin)) {
              try {
                require('./lib/feedback-remote/autoStartedSession.cjs').autoStartFollowUp({
                  cwd, tabId, sessionId, send: enqueueExternalPrompt,
                });
              } catch (err) {
                console.error('[chatRunner] auto-start follow-up failed:', err?.message ?? err);
              }
            }
          }
        } else {
          emitTerminal('chat:run:error', {
            tabId,
            sessionId,
            message: `run ended with result subtype: ${event.subtype ?? 'unknown'}`,
          }, { code: 'result-error' });
        }
      }
    };

    // Agent-CLI turns: the adapter's parser translates each native line into Claude
    // stream-json events, which are recorded and then fed through processLine unchanged.
    let nativeIdSaved = false;
    const processAgentEvents = (events) => {
      for (const ev of Array.isArray(events) ? events : []) {
        try { agentPlan.transcript.event(ev); } catch { /* transcript never fails a turn */ }
        if (ev && ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string'
            && ev.session_id && !nativeIdSaved) {
          nativeIdSaved = true;
          try {
            writeNativeSession(sessionId, { cli: agentPlan.cli, nativeSessionId: ev.session_id });
          } catch (err) {
            logs.writeLine({ scope: 'chatRunner', level: 'warn', message: `agent-cli native session write failed: ${err?.message ?? err}` });
          }
        }
        processLine(JSON.stringify(ev));
      }
    };
    const handleLine = (line) => {
      if (!agentPlan) { processLine(line); return; }
      if (!line) return;
      let events = [];
      try { events = agentPlan.parser.push(line); } catch { events = []; }
      processAgentEvents(events);
    };

    thisChild.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        handleLine(lineBuffer.slice(0, nl).trim());
        lineBuffer = lineBuffer.slice(nl + 1);
      }
      if (lineBuffer.length > LINE_BUFFER_MAX) {
        // Un-terminated line past the cap: drop it rather than grow forever.
        lineBuffer = '';
        if (!lineOverflowLogged) {
          lineOverflowLogged = true;
          opsErrorLog.appendError({
            cwd,
            scope: 'chatRunner',
            code: 'stdout-line-overflow',
            tabId,
            tags: silent ? ['silent-probe'] : [],
            message: `stdout line exceeded ${LINE_BUFFER_MAX} bytes without a newline; buffer dropped`,
            meta: { sessionId, silent },
          });
        }
      }
    });

    thisChild.stderr.on('data', (chunk) => {
      stderrBuffer.append(chunk.toString('utf8'));
    });

    thisChild.on('error', (err) => {
      clearTimeout(killTimer);
      clearTimeout(warnTimer);
      emitTerminal('chat:run:error', {
        tabId,
        sessionId,
        message: err?.message ?? String(err),
      }, { code: 'child-error' });
      settle();
    });

    // 'close' (not 'exit') so this fallback only runs after Node guarantees
    // every buffered stdout 'data' chunk has been delivered — 'exit' can fire
    // before the final chunk (last assistant text + terminating `result`
    // line) reaches the 'data' handler above, which raced this fallback into
    // firing first and dropping the real chat:run:complete behind the
    // terminalSent latch.
    thisChild.on('close', (code, signal) => {
      // Flush any partial line that didn't end with \n
      if (lineBuffer.trim()) handleLine(lineBuffer.trim());
      if (agentPlan) {
        let endEvents = [];
        try { endEvents = agentPlan.parser.end({ exitCode: code }); } catch { endEvents = []; }
        processAgentEvents(endEvents);
        try { agentPlan.transcript.close(); } catch { /* never fails a turn */ }
      }

      // Flag-swap retry: the CLI rejected the session flag before doing any
      // work. Retry exactly once with the other flag; the timers, lane and
      // terminal latch stay at executeRun level, so this is still one turn.
      if (!agentPlan && !terminalSent && !killed && code !== 0 && attemptNo === 1
          && finalAssistantText === '' && recentToolUses.length === 0
          && !/rate.?limit/i.test(stderrText())) {
        const swapTo = resumeFlag
          ? (NO_CONVERSATION_RE.test(stderrText()) ? false : null)
          : (SESSION_IN_USE_RE.test(stderrText()) ? true : null);
        if (swapTo !== null) {
          if (!silent) {
            broadcast('chat:run:notice', {
              tabId,
              sessionId,
              message: `Session flag mismatch (${resumeFlag ? '--resume' : '--session-id'} rejected); retrying once with ${swapTo ? '--resume' : '--session-id'}.`,
            });
          }
          startAttempt(swapTo, 2);
          return;
        }
      }

      clearTimeout(killTimer);
      clearTimeout(warnTimer);

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
          }, { level: 'info', code: 'cancelled' });
        } else if (SESSION_IN_USE_RE.test(stderrText()) || NO_CONVERSATION_RE.test(stderrText())) {
          // A session-flag rejection that survived the one-shot swap (or was
          // not eligible for it). The raw stderr dump names neither the flag,
          // the cwd nor the transcript — a real report cost a full diagnostic
          // session to trace to a stale app build, because flag resolution
          // lives in main and older builds resolve it with older rules.
          let appVersion = 'unknown';
          try { appVersion = require('electron').app.getVersion() || 'unknown'; } catch { /* never fail the turn */ }
          emitTerminal('chat:run:error', {
            tabId,
            sessionId,
            code: 'session_flag_exhausted',
            message: `The Claude CLI rejected the session flag (${resumeFlag ? '--resume' : '--session-id'} on this attempt; `
              + `${attemptNo === 2 ? 'the one-shot swap retry with the other flag was already spent' : 'no swap retry was possible'}). `
              + `Spawn cwd: ${execCwd}. Transcript: ${plan.transcriptPath ?? 'no transcript found on disk'}. `
              + `App version: ${appVersion}. If this version is behind the published latest, update the app first — `
              + 'the session-flag resolution logic lives in main, and a stale build resolves it with older rules.',
          }, { code: 'session-flag-rejected' });
        } else {
          const preview = stderrBuffer.preview();
          const errDetail = preview ? `: ${preview}` : '';
          emitTerminal('chat:run:error', {
            tabId,
            sessionId,
            message: `process exited without a result event (code=${code} signal=${signal})${errDetail}`,
          }, { code: 'exit-no-result' });
        }
      }
      if (artifactsDir) ingestChatArtifacts({ cwd, sessionId, srcDir: artifactsDir });
      settle();
    });
    };

    startAttempt(useResume, 1);
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
  const parked = pendingStart.get(tabId);
  if (parked) {
    pendingStart.delete(tabId);
    if (!parked.silent) {
      broadcast('chat:run:error', { tabId: parked.tabId, sessionId: parked.sessionId, message: 'cancelled while queued' });
    }
    return Promise.resolve();
  }
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

const pendingExternalSends = new Map(); // requestId -> { resolve, timer }
// requestId -> expiry timer. A send that timed out may still be acked by the
// renderer; a late ack that produced a run confirms the held-turn entries it carried.
const timedOutExternalSends = new Map();
const TIMED_OUT_SEND_TTL_MS = 10 * 60 * 1000;

function rememberTimedOutSend(requestId) {
  const t = setTimeout(() => { timedOutExternalSends.delete(requestId); }, TIMED_OUT_SEND_TTL_MS);
  t.unref?.();
  timedOutExternalSends.set(requestId, t);
}

function hasLiveWindow() {
  try {
    return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed());
  } catch { return false; }
}

/**
 * Resolves { disposition, reason? } once the renderer reports what it did, or
 * { disposition: 'unconfirmed', reason: 'no-window' } / { disposition: 'unconfirmed',
 * reason: 'timeout', requestId } (a late ack may still confirm a held batch). Never rejects.
 */
// tabId -> identity key of the usage hold last audited for it (one audit per tab per hold).
const heldTurnAuditKeys = new Map();

function schedulerHoldKey(hold) {
  try {
    const { holdIdentityKey } = require('./scheduler/utilizationHold.cjs');
    if (typeof holdIdentityKey === 'function') return holdIdentityKey(hold);
  } catch { /* fall through to the local key */ }
  return `${hold.reason}|${hold.window ?? ''}|${hold.resetsAt ?? ''}`;
}

/**
 * Usage-hold seam: a scheduler-started turn under an active hold is deferred to the
 * held store (no broadcast, no claude process). Returns the disposition, or null
 * when the turn may run now. Required lazily to keep load order safe.
 */
function holdSchedulerTurn(tabId, prompt, extra) {
  const heldSchedulerTurns = require('./lib/scheduler/heldSchedulerTurns.cjs');
  const hold = heldSchedulerTurns.currentHold();
  if (!hold) return null;
  // A drain batch held again keeps its original entries; re-deferring it would
  // nest coalesced headers on the next delivery.
  if (extra.heldBatch === true) return { disposition: 'held', reason: hold.reason };
  const { sessionId, cwd, heldKind } = extra;
  const entry = heldSchedulerTurns.defer({ tabId, prompt, kind: heldKind || 'scheduler-notice', sessionId, cwd, hold });
  const key = schedulerHoldKey(hold);
  if (heldTurnAuditKeys.get(tabId) !== key) {
    heldTurnAuditKeys.set(tabId, key);
    // The turn kind is `heldKind`: appendAuditEvent spreads fields over the record,
    // so a `kind` field would overwrite the event kind itself.
    require('./lib/telemetry/auditLog.cjs').appendAuditEvent('scheduler_turn_held', {
      tabId,
      heldKind: entry.kind,
      reason: hold.reason ?? null,
      window: hold.window ?? null,
      percent: hold.percent ?? null,
      threshold: hold.threshold ?? null,
    });
  }
  return { disposition: 'held', reason: hold.reason };
}

function enqueueExternalPrompt(tabId, prompt, extra = {}) {
  const { sessionId, cwd, origin, relay } = extra ?? {};
  if (origin === 'scheduler') {
    const heldResult = holdSchedulerTurn(tabId, prompt, extra ?? {});
    if (heldResult) return Promise.resolve(heldResult);
  }
  if (!hasLiveWindow()) return Promise.resolve({ disposition: 'unconfirmed', reason: 'no-window' });
  if (origin === 'scheduler') noteSchedulerPrompt(tabId, prompt);
  const note = origin !== 'scheduler' && relay !== undefined ? noteRelayPrompt(tabId, prompt, relay) : null;
  const requestId = require('node:crypto').randomUUID();
  return new Promise((done) => {
    // A send that produced no run (refused / unconfirmed) never leaves its note behind.
    const resolve = (result) => {
      if (note && (result.disposition === 'refused' || result.disposition === 'unconfirmed')) {
        dropRelayPrompt(tabId, prompt, note);
      }
      done(result);
    };
    const timer = setTimeout(() => {
      pendingExternalSends.delete(requestId);
      rememberTimedOutSend(requestId);
      resolve({ disposition: 'unconfirmed', reason: 'timeout', requestId });
    }, EXTERNAL_SEND_ACK_TIMEOUT_MS);
    timer.unref?.();
    pendingExternalSends.set(requestId, { resolve, timer });
    broadcast('chat:external-send', {
      requestId,
      tabId,
      prompt,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    });
  });
}

function settleExternalSend({ requestId, disposition, reason }) {
  const entry = pendingExternalSends.get(requestId);
  if (!entry) {
    const late = timedOutExternalSends.get(requestId);
    if (late === undefined) return;
    clearTimeout(late);
    timedOutExternalSends.delete(requestId);
    if (disposition !== 'refused' && disposition !== 'unconfirmed') {
      try {
        require('./lib/scheduler/heldSchedulerTurns.cjs').confirmLateDelivery(requestId);
      } catch (err) {
        console.error('[chatRunner] confirmLateDelivery failed:', err);
      }
    }
    return;
  }
  clearTimeout(entry.timer);
  pendingExternalSends.delete(requestId);
  entry.resolve({ disposition, ...(reason !== undefined ? { reason } : {}) });
}

// Asks the renderer to start a new Session (same launchSession a macro press
// uses) on behalf of the paired phone. Payload is pre-validated by the caller.
function requestExternalNewSession(payload) {
  broadcast('chat:external-new-session', payload);
}

// Awaited sibling of requestExternalNewSession for the admin route
// (POST /admin/macros/run): tags the payload with a requestId and resolves
// once the renderer reports which Epic it minted. Never rejects.
const EXTERNAL_NEW_SESSION_TIMEOUT_MS = 30000;
const pendingExternalNewSessions = new Map(); // requestId -> { resolve, timer }

/**
 * Every payload key (incl. a boolean `reviewStage`) is broadcast unchanged.
 * @returns {Promise<{ ok: true, epicId: string, entryId?: string, slug?: string, stage?: 'review'|'final'|null } | { ok: false, reason: 'no-window'|'timeout'|'launch-failed', error: string }>}
 */
function startExternalNewSession(payload) {
  if (!hasLiveWindow()) {
    return Promise.resolve({ ok: false, reason: 'no-window', error: 'Session Manager window is not open' });
  }
  const requestId = require('node:crypto').randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingExternalNewSessions.delete(requestId);
      resolve({ ok: false, reason: 'timeout', error: 'renderer did not report the new session in time' });
    }, EXTERNAL_NEW_SESSION_TIMEOUT_MS);
    timer.unref?.();
    pendingExternalNewSessions.set(requestId, { resolve, timer });
    broadcast('chat:external-new-session', { ...payload, requestId });
  });
}

function settleExternalNewSession({ requestId, ok, epicId, error, entryId, slug, stage }) {
  const entry = pendingExternalNewSessions.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingExternalNewSessions.delete(requestId);
  if (ok && epicId) {
    entry.resolve({
      ok: true,
      epicId,
      ...(entryId !== undefined ? { entryId } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(stage !== undefined ? { stage } : {}),
    });
  } else entry.resolve({ ok: false, reason: 'launch-failed', error: error || 'renderer could not start the session' });
}

// Read-only: is a chat turn for this tab running, being dispatched, parked
// behind a worktree mint, or queued?
function isTabBusy(tabId) {
  return inFlight.has(tabId)
    || dispatching.has(tabId)
    || pendingStart.has(tabId)
    || waiting.some((w) => w.tabId === tabId);
}

/**
 * Registers the admin-HTTP entry point for enqueueExternalPrompt, mirroring
 * prdCreate.cjs's registerAdminRoute pattern (auth is the injected transport's
 * job; this only owns route logic + body parsing).
 */
function registerAdminRoute(adminHttp) {
  const { readBody, sendJson } = require('./lib/feedback-remote/localAdminHttp.cjs');
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
    const outcome = await enqueueExternalPrompt(body.tabId, body.prompt, { relay: 'admin-api' });
    sendJson(res, 200, {
      ok: outcome.disposition !== 'refused',
      disposition: outcome.disposition,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    });
  });
}

// ─── IPC handler registration ─────────────────────────────────────────────

/**
 * Record a chat prompt into the human prompt ledger, only when the renderer
 * explicitly declared origin === 'human'. Absent/other origins are not-human
 * (fail-closed). Never throws.
 * @param {{ sessionId: string, prompt: string, origin?: string }} args
 */
function noteChatRunOrigin({ sessionId, prompt, origin }) {
  try {
    if (origin !== 'human') return;
    require('./lib/feedback-remote/humanPromptLedger.cjs').recordHumanPrompt(sessionId, prompt);
  } catch {
    /* never throws */
  }
}

function registerChatHandlers() {
  const { schemas, validated } = require('./ipcSchemas.cjs');

  ipcMain.handle('chat:run', validated(schemas.chatRun, async ({ tabId, sessionId, prompt, cwd, resume, promptId, origin }) => {
    noteChatRunOrigin({ sessionId, prompt, origin });
    // Report what actually happened instead of an unconditional { ok: true }.
    // A user send is always accepted now (queued behind the tab's live run if
    // one holds it), but the renderer gets the truth either way rather than a
    // success it can't verify.
    const outcome = run({ tabId, sessionId, prompt, cwd, resume: !!resume, promptId, origin });
    return { ok: outcome.accepted !== false, queued: !!outcome.queued, reason: outcome.reason };
  }));

  // Classification for a queued PromptTicket reaching the front of its
  // per-tab queue (PRD 749) — a direct bounded call, never a scheduler job
  // (see classifyPromptTicket.cjs's docblock for why that would be circular).
  ipcMain.handle('chat:classify-ticket', validated(schemas.chatClassifyTicket, async ({ text }) => {
    return classifyPromptTicket(text);
  }));

  ipcMain.handle('chat:external-send-result', validated(schemas.chatExternalSendResult, async (payload) => {
    settleExternalSend(payload);
  }));

  ipcMain.handle('chat:external-new-session-result', validated(schemas.chatExternalNewSessionResult, async (payload) => {
    settleExternalNewSession(payload);
  }));

  ipcMain.handle('chat:cancel', async (_e, payload) => {
    let tabId;
    try { tabId = schemas.chatCancel.parse(payload).tabId; } catch { return; }
    await cancel(tabId);
  });

}

const undecidedLogged = new Set();

/**
 * Servers in the argv's --mcp-config that no --agents tools entry (mcp__<s> or mcp__<s>__*) grants.
 * [] when either flag is absent or unparseable. Pure.
 * @param {string[]} args
 * @returns {string[]}
 */
function ungrantedMcpServers(args) {
  if (!Array.isArray(args)) return [];
  const ai = args.indexOf('--agents');
  const mi = args.indexOf('--mcp-config');
  if (ai < 0 || mi < 0) return [];
  let tools; let servers;
  try {
    const agents = JSON.parse(args[ai + 1]);
    const def = agents && agents[HEADLESS_SCOPE_AGENT_NAME];
    tools = def && Array.isArray(def.tools) ? def.tools.map(String) : null;
    servers = Object.keys((JSON.parse(args[mi + 1]) || {}).mcpServers || {});
  } catch { return []; }
  if (!tools) return [];
  const granted = new Set(tools.filter((t) => t.startsWith('mcp__')).map((t) => t.slice(5).split('__')[0]));
  return servers.filter((s) => !granted.has(s));
}

/**
 * Gear for a chat turn (PRD 4768): the argv that gives an Epic whose pinned snapshot carries
 * `gearBindsChat` the same scope a job gets — persona tools, strict MCP with the declared servers,
 * packs' skill allow-list. HEADLESS_DISALLOWED_TOOLS is deliberately NOT applied to chat.
 * Unstamped (older) snapshots and Unbound personas add nothing; Undecided runs unscoped.
 * An unknown declared server/pack never crashes the turn: it is dropped and reported in `errors`.
 * Pure apart from reading ~/.claude.json and <cwd>/.mcp.json (declared servers), the pack catalog and the seeded MCP entry (injectable for tests).
 * `projectRoot` is the Epic's main project cwd: a worktree `cwd` still sees servers under projects[<main root>].
 * @param {{ snapshot: any, cwd?: string, projectRoot?: string, deps?: { home?: string, knownMcpServers?: Record<string, object>, listPacks?: () => { packs: any[] }, listUnpackedSkills?: () => string[], log?: (msg: string) => void, scopeArgs?: typeof personaToolScopeArgs } }} opts
 * @returns {{ args: string[], errors: string[] }}
 */
function gearChatArgs({ snapshot, cwd, projectRoot, deps = {} }) {
  const none = { args: [], errors: [] };
  if (!snapshot || snapshot.gearBindsChat !== true) return none;
  const loadout = snapshot.loadout;
  if (loadout === 'unbound') return none;
  if (loadout === 'undecided') {
    const key = String(snapshot.name || '');
    if (!undecidedLogged.has(key)) {
      undecidedLogged.add(key);
      try { (deps.log || ((m) => logs.writeLine({ scope: 'chatRunner', level: 'info', message: m })))(`persona "${key}" is undecided about gear; chat runs unscoped`); } catch { /* logging must never fail a turn */ }
    }
    return none;
  }
  let known = deps.knownMcpServers;
  /** @type {Record<string, string>} */
  let credentialed = {};
  if (!known) {
    try {
      const r = require('./lib/claude/headlessMcpServers.cjs').resolveHeadlessMcpServers({ cwd, projectRoot, ...(deps.home ? { home: deps.home } : {}) });
      known = r.known;
      credentialed = r.credentialed;
    } catch { known = {}; }
  }
  let catalog = [];
  try { catalog = (deps.listPacks || require('./lib/packs/packCatalog.cjs').listPacks)().packs || []; } catch { catalog = []; }
  let unpacked = [];
  try { unpacked = (deps.listUnpackedSkills || require('./lib/packs/packCatalog.cjs').listUnpackedSkills)(); } catch { unpacked = []; }
  const packs = Array.isArray(snapshot.packs) ? snapshot.packs.map(String) : [];
  const knownPackIds = new Set(catalog.map((p) => String(p.id)));
  const personaDeclared = Array.isArray(snapshot.mcpServers) ? snapshot.mcpServers.map(String) : [];
  // SM's own harness rides every scoped chat; the scheduler is always kept so its absence is reported below.
  const harness = CHAT_HARNESS_MCP_SERVERS.filter((n) => n === 'session-manager-scheduler' || Object.prototype.hasOwnProperty.call(known || {}, n));
  const declared = [...new Set([...personaDeclared, ...harness])];
  const scope = buildPersonaToolScope(snapshot.tools, { loadout, disallowed: [] });
  const scopeFn = deps.scopeArgs || personaToolScopeArgs;
  const attempt = scopeFn(scope, { mcpServers: known, declaredServers: declared, packs, knownPacks: [...knownPackIds] });
  /** @type {string[]} */ const errors = [];
  let scopeArgs = attempt.args;
  let equipped = packs;
  if (attempt.refusal) {
    // Run without the unknown capability instead of failing the turn: drop it and re-derive.
    const bad = new Set();
    let r = attempt.refusal;
    let guard = 0;
    let curDeclared = declared;
    let curPacks = packs;
    let curScope = scope;
    let cur = attempt;
    while (r && guard++ < 50) {
      bad.add(r.name);
      errors.push(Object.prototype.hasOwnProperty.call(credentialed, r.name)
        ? `Gear: "${r.name}" is not available (${credentialed[r.name]}); this turn runs without it.`
        : `Gear: "${r.name}" is not available; this turn runs without it.`);
      curDeclared = curDeclared.filter((d) => d !== r.name);
      curPacks = curPacks.filter((p) => p !== r.name);
      curScope = curScope ? { tools: curScope.tools.filter((t) => !(t.startsWith('mcp__') && t.slice(5).split('__')[0] === r.name) && t !== r.name) } : curScope;
      cur = scopeFn(curScope, { mcpServers: known, declaredServers: curDeclared, packs: curPacks, knownPacks: [...knownPackIds] });
      r = cur.refusal;
    }
    scopeArgs = cur.args;
    equipped = curPacks;
  }
  // A loaded-but-ungranted server is invisible to the CLI (even ToolSearch) — never omit it silently.
  for (const name of ungrantedMcpServers(scopeArgs)) errors.push(`Gear: "${name}" was loaded but not granted to this chat's tools; its tools are unavailable this turn.`);
  const installedSkills = [...new Set([...catalog.flatMap((p) => p.skills || []), ...unpacked].map(String))];
  const deny = skillDenyArgs({ installedSkills, equippedPacks: equipped, packCatalog: catalog, loadout });
  return { args: [...scopeArgs, ...deny], errors };
}

module.exports = {
  run,
  cancel,
  __resetQueueForTests,
  holdOrphanSession,
  releaseOrphanSession,
  __liveSessionCount: () => liveSessions.size,
  attachWindow,
  registerChatHandlers,
  noteChatRunOrigin,
  turnInstructionFor,
  gearChatArgs,
  ungrantedMcpServers,
  shouldFollowUp,
  parseStopSignal,
  splitStopSignal,
  recordNeedsInput,
  recordAnswerIfOpen,
  parseContextUsageMarkdown,
  STOP_SENTINEL,
  // Both instruction blocks are exported so the renderer's preamble splitter
  // (lib/promptPreamble.ts) can be drift-tested against the REAL text rather
  // than a copy — see chat-preamble-anchors.test.cjs.
  STOP_SIGNAL_INSTRUCTION,
  SCHEDULER_TURN_INSTRUCTION,
  CHAT_MODE_TRUTH_INSTRUCTION,
  KILL_CEILING_MS,
  KILL_CEILING_MIN,
  WARN_CEILING_MS,
  __setExecutor,
  enqueueExternalPrompt,
  settleExternalSend,
  EXTERNAL_SEND_ACK_TIMEOUT_MS,
  RELAY_RUN_START_WINDOW_MS,
  RELAY_PROMPT_TTL_MS,
  __relayNoteCount: relayNoteCount,
  requestExternalNewSession,
  startExternalNewSession,
  settleExternalNewSession,
  isTabBusy,
  EXTERNAL_NEW_SESSION_TIMEOUT_MS,
  registerAdminRoute,
  // test-only: the chat turn-end artifact ingest (chatRunnerArtifactNotice.test.cjs)
  __ingestChatArtifacts: ingestChatArtifacts,
};
