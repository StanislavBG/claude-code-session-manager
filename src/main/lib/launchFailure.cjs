'use strict';

/**
 * launchFailure.cjs — detects a headless `claude -p` run that NEVER RAN, and
 * models the per-persona launch circuit breaker the scheduler routes on.
 *
 * Incident (GitHub issue #11, 2026-09-02, macOS): the installed Claude CLI
 * sent `thinking.type.enabled` to a model that only accepts
 * `thinking.type.adaptive`. The API answered HTTP 400 on the very first
 * request, so every job did zero turns, spent zero output tokens, wrote zero
 * files, exited 1 in ~25 s — and was recorded as `failed` with `error: null`,
 * indistinguishable from a real implementation failure. The auto-fix
 * investigation probe then launched with the same CLI and died the same way.
 * 12 of 41 transcripts in one project over a month were this signature.
 *
 * Two facts this module makes first-class:
 *
 *  1. A NON-RUN is not a failure of the PRD. `classifyLaunchFailure` is
 *     deliberately narrow — it only fires when the transcript's `result`
 *     event shows no real turn (num_turns ≤ 1 AND output_tokens = 0) AND the
 *     result text carries the CLI's literal `API Error:` prefix. Anything
 *     that did a turn, or failed without the API marker, is somebody else's
 *     classification (rate-limit, network, transient, verifier).
 *
 *  2. The environment is broken, not the job — so the scheduler must stop
 *     re-dispatching identical launches (each one is a wasted 25 s + a
 *     misleading `failed` row + a doomed investigation) while still
 *     self-healing the moment the environment is fixed. That is a circuit
 *     breaker keyed by the launch persona (`agentType` → model): closed
 *     (normal) → open (blocked, exponential backoff) → half-open (exactly one
 *     probe job goes through) → closed again on a real turn. A CLI version
 *     change (the actual fix for the incident: `claude update`) short-circuits
 *     the backoff so the queue resumes on the next tick, not the next hour.
 *
 * Pure and Electron-free: every function here takes plain values (a parsed
 * result event, a block record, `now`) so the whole state machine is
 * unit-testable without a spawn. scheduler.cjs owns the I/O around it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readTail } = require('./fileTail.cjs');

const LAUNCH_FAILURE_KINDS = Object.freeze({
  /** HTTP 400 naming a thinking/effort/config parameter the model rejects — the issue-#11 signature. */
  MODEL_CONFIG_REJECTED: 'model_config_rejected',
  /** Any other HTTP 400 on the first request (malformed request body, unsupported flag combo). */
  BAD_REQUEST: 'bad_request',
  /** HTTP 401/403 — the CLI's credentials are missing, expired, or lack access to the model. */
  AUTH_FAILED: 'auth_failed',
  /** HTTP 404 that names the model — the pinned `--model` does not exist for this account/CLI. */
  MODEL_NOT_FOUND: 'model_not_found',
  /** HTTP 5xx / 529 / "Overloaded" — the API itself is unavailable right now. */
  API_OVERLOADED: 'api_overloaded',
  /** Any other first-request API error. */
  API_ERROR: 'api_error',
});

/** Tail bytes scanned for the `result` event — same budget classifyRunOutcome uses. */
const RESULT_TAIL_BYTES = 65536;

/**
 * Parse the LAST `{"type":"result",...}` stream-json event out of a log tail.
 * Returns a flat, typed summary or null when no result event is present
 * (the process died before the harness could emit one — that is
 * reaperHelpers' `no_result`, not a launch failure).
 */
function parseResultEvent(text) {
  if (!text) return null;
  let last = null;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.includes('"type":"result"')) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && obj.type === 'result') last = obj;
    } catch { /* partial line at the tail boundary */ }
  }
  if (!last) return null;
  const usage = last.usage && typeof last.usage === 'object' ? last.usage : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    subtype: typeof last.subtype === 'string' ? last.subtype : '',
    isError: last.is_error === true,
    numTurns: num(last.num_turns),
    outputTokens: num(usage.output_tokens),
    inputTokens: num(usage.input_tokens),
    apiErrorStatus: num(last.api_error_status),
    totalCostUsd: num(last.total_cost_usd),
    durationMs: num(last.duration_ms),
    terminalReason: typeof last.terminal_reason === 'string' ? last.terminal_reason : null,
    resultText: typeof last.result === 'string' ? last.result : '',
  };
}

function readResultEvent(logPath) {
  try {
    return parseResultEvent(readTail(logPath, RESULT_TAIL_BYTES));
  } catch {
    return null;
  }
}

/**
 * Pull the human-readable message out of the CLI's `API Error: <status> <json>`
 * text. The body nests unpredictably (`{"error":{"message":...}}`, or
 * `{"detail":{"error":"<json string with message>"}}` as in issue #11), so
 * this walks any `message`/`error` chain it can parse and falls back to the
 * raw text, bounded.
 */
function extractApiMessage(text) {
  const raw = String(text || '').trim();
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    let node;
    try { node = JSON.parse(raw.slice(jsonStart)); } catch { node = null; }
    let depth = 0;
    while (node && depth < 6) {
      depth += 1;
      if (typeof node === 'string') {
        const s = node.trim();
        if (s.startsWith('{')) {
          try { node = JSON.parse(s); continue; } catch { /* not JSON — it's the message */ }
        }
        return s.slice(0, 400);
      }
      if (typeof node !== 'object') break;
      if (typeof node.message === 'string') return node.message.slice(0, 400);
      node = node.error ?? node.detail ?? null;
    }
  }
  return raw.slice(0, 400);
}

/**
 * classifyLaunchFailure(result) → null | { kind, httpStatus, message }
 *
 * `result` is parseResultEvent()'s output. Returns null for every run that
 * did real work (or failed for a reason that is not a first-request API
 * rejection) — the narrowness is the point; see the module header.
 * HTTP 429 is excluded: the rate-limit pause path owns it.
 */
function classifyLaunchFailure(result) {
  if (!result) return null;
  const numTurns = result.numTurns ?? 0;
  const outputTokens = result.outputTokens ?? 0;
  if (numTurns > 1 || outputTokens > 0) return null;
  const text = result.resultText || '';
  const marker = /API Error:?\s*(\d{3})?/i.exec(text);
  if (!marker && !(result.isError && result.apiErrorStatus)) return null;
  const httpStatus = (marker && marker[1] ? Number(marker[1]) : null) ?? result.apiErrorStatus ?? null;
  if (httpStatus === 429) return null;
  const message = extractApiMessage(text.replace(/^.*?API Error:?\s*(\d{3})?\s*/i, '')) || text.slice(0, 400);
  let kind;
  if (httpStatus === 400) {
    kind = /thinking|not supported for this model|output_config|effort/i.test(text)
      ? LAUNCH_FAILURE_KINDS.MODEL_CONFIG_REJECTED
      : LAUNCH_FAILURE_KINDS.BAD_REQUEST;
  } else if (httpStatus === 401 || httpStatus === 403) {
    kind = LAUNCH_FAILURE_KINDS.AUTH_FAILED;
  } else if (httpStatus === 404 && /model/i.test(text)) {
    kind = LAUNCH_FAILURE_KINDS.MODEL_NOT_FOUND;
  } else if ((httpStatus !== null && httpStatus >= 500) || /overloaded/i.test(text)) {
    kind = LAUNCH_FAILURE_KINDS.API_OVERLOADED;
  } else {
    kind = LAUNCH_FAILURE_KINDS.API_ERROR;
  }
  return { kind, httpStatus, message };
}

/** Did this run get at least one real model turn? (The half-open probe's "close the breaker" evidence.) */
function resultShowsRealTurn(result) {
  if (!result) return false;
  return (result.numTurns ?? 0) > 1 || (result.outputTokens ?? 0) > 0;
}

// ─── Circuit breaker ────────────────────────────────────────────────────────

/** After this many consecutive failed probes the block stays open until the CLI version changes or a human resets it. */
const LAUNCH_BLOCK_MAX_ATTEMPTS = 8;
/** A probe that has not reported back in this long is presumed dead; the next tick may probe again. */
const LAUNCH_PROBE_STALE_MS = 30 * 60_000;

const BACKOFF_BASE_MS = {
  [LAUNCH_FAILURE_KINDS.MODEL_CONFIG_REJECTED]: 5 * 60_000,
  [LAUNCH_FAILURE_KINDS.BAD_REQUEST]: 5 * 60_000,
  [LAUNCH_FAILURE_KINDS.AUTH_FAILED]: 5 * 60_000,
  [LAUNCH_FAILURE_KINDS.MODEL_NOT_FOUND]: 10 * 60_000,
  [LAUNCH_FAILURE_KINDS.API_OVERLOADED]: 60_000,
  [LAUNCH_FAILURE_KINDS.API_ERROR]: 2 * 60_000,
};
const BACKOFF_CAP_MS = 60 * 60_000;

/** Exponential backoff for the Nth consecutive failure (attempts ≥ 1), capped at one hour. */
function backoffMsFor(kind, attempts) {
  const base = BACKOFF_BASE_MS[kind] ?? BACKOFF_BASE_MS[LAUNCH_FAILURE_KINDS.API_ERROR];
  const n = Math.max(0, (attempts ?? 1) - 1);
  return Math.min(BACKOFF_CAP_MS, base * 2 ** n);
}

/**
 * Environment the scheduler applies to a launch as a DEGRADED-MODE
 * mitigation for a kind, or null when there is none. For the issue-#11
 * signature the CLI's `MAX_THINKING_TOKENS=0` switches extended thinking off
 * entirely, so an older CLI stops sending the rejected `thinking` block at
 * all — the run proceeds without thinking rather than not at all. Harmless
 * if the CLI ignores it (the probe simply fails again and the backoff holds).
 */
function mitigationEnvFor(kind) {
  if (kind === LAUNCH_FAILURE_KINDS.MODEL_CONFIG_REJECTED) return { MAX_THINKING_TOKENS: '0' };
  return null;
}

/** Circuit-breaker key: the launch persona, because `agentType` is what selects the `--model`. */
function launchBlockKeyFor(job) {
  return (job && typeof job.agentType === 'string' && job.agentType) || 'default';
}

/** Operator-facing explanation + the one action that clears the condition. */
function launchFailureHint(kind, { claudeVersion, mitigationInForce = false } = {}) {
  const ver = claudeVersion ? `installed Claude CLI ${claudeVersion}` : 'installed Claude CLI';
  switch (kind) {
    case LAUNCH_FAILURE_KINDS.MODEL_CONFIG_REJECTED:
      return mitigationInForce
        ? `The ${ver} sends a thinking parameter this model rejects, and disabling thinking (MAX_THINKING_TOKENS=0) did not get past it. Update the CLI (\`claude update\` or \`npm i -g @anthropic-ai/claude-code@latest\`); the queue resumes automatically when the version changes.`
        : `The ${ver} sends a thinking parameter this model rejects (HTTP 400 on the first request — no work was attempted). Update the CLI (\`claude update\` or \`npm i -g @anthropic-ai/claude-code@latest\`); until then jobs re-probe with thinking disabled, and the queue resumes automatically when the version changes.`;
    case LAUNCH_FAILURE_KINDS.AUTH_FAILED:
      return `The API rejected the CLI's credentials (HTTP 401/403) before any work started. Run \`claude login\` (or check the model is enabled for this account), then press Retry now.`;
    case LAUNCH_FAILURE_KINDS.MODEL_NOT_FOUND:
      return `The pinned --model does not exist for the ${ver} / this account (HTTP 404). Fix the persona's \`model:\` in the Agent Library or update the CLI, then press Retry now.`;
    case LAUNCH_FAILURE_KINDS.API_OVERLOADED:
      return 'The API is overloaded or unavailable (HTTP 5xx/529). Nothing is wrong with the PRD; the scheduler re-probes with backoff and resumes on its own.';
    case LAUNCH_FAILURE_KINDS.BAD_REQUEST:
      return `The API rejected the launch request (HTTP 400) before any work started. Check the ${ver} against the pinned model, then press Retry now.`;
    default:
      return 'The first API request of the run failed before any work started. The scheduler re-probes with backoff; press Retry now to probe immediately.';
  }
}

/**
 * armLaunchBlock(prev, failure) → block
 *
 * Opens (or re-opens with a longer backoff) the breaker for one key after a
 * launch failure. `prev` is the existing block for the key or null; a
 * different `kind` than before restarts the attempt count, the same kind
 * escalates it. Beyond LAUNCH_BLOCK_MAX_ATTEMPTS `until` becomes null:
 * blocked indefinitely — only a CLI version change or a human Retry clears
 * it, and the UI says so.
 */
function armLaunchBlock(prev, { kind, httpStatus, message, now, claudeVersion, slug, runId, mitigationApplied = false }) {
  const sameKind = prev && prev.kind === kind;
  const attempts = sameKind ? (prev.attempts ?? 0) + 1 : 1;
  const exhausted = attempts >= LAUNCH_BLOCK_MAX_ATTEMPTS;
  const mitigationEnv = mitigationEnvFor(kind);
  return {
    kind,
    httpStatus: httpStatus ?? null,
    message: String(message || '').slice(0, 400),
    hint: launchFailureHint(kind, { claudeVersion, mitigationInForce: mitigationApplied }),
    since: sameKind && prev.since ? prev.since : new Date(now).toISOString(),
    lastAt: new Date(now).toISOString(),
    until: exhausted ? null : new Date(now + backoffMsFor(kind, attempts)).toISOString(),
    attempts,
    exhausted,
    claudeVersion: claudeVersion ?? null,
    lastSlug: slug ?? null,
    lastRunId: runId ?? null,
    mitigationEnv,
    mitigationApplied,
    probing: null,
  };
}

/**
 * evaluateLaunchGate(block, { now, claudeVersion }) →
 *   { state: 'open' | 'blocked' | 'probe', reason }
 *
 * 'open'    — no block, or the CLI version changed since it was armed (the
 *             caller should drop the block: the environment was replaced).
 * 'blocked' — inside the backoff window, exhausted, or a probe is already in
 *             flight. `reason` is the row-level hold text.
 * 'probe'   — backoff elapsed: let exactly ONE job through as the probe.
 */
function evaluateLaunchGate(block, { now, claudeVersion } = {}) {
  if (!block) return { state: 'open', reason: null };
  if (claudeVersion && block.claudeVersion && claudeVersion !== block.claudeVersion) {
    return { state: 'open', reason: `cli-version-changed (${block.claudeVersion} → ${claudeVersion})` };
  }
  const t = typeof now === 'number' ? now : Date.now();
  if (block.probing && block.probing.at) {
    const age = t - Date.parse(block.probing.at);
    if (Number.isFinite(age) && age >= 0 && age < LAUNCH_PROBE_STALE_MS) {
      return { state: 'blocked', reason: `launch blocked (${block.kind}) — probe ${block.probing.slug} in flight` };
    }
  }
  if (block.until === null || block.until === undefined) {
    return { state: 'blocked', reason: `launch blocked (${block.kind}) after ${block.attempts} failed probe(s) — ${block.hint}` };
  }
  const until = Date.parse(block.until);
  if (Number.isFinite(until) && t < until) {
    const mins = Math.max(1, Math.round((until - t) / 60_000));
    return { state: 'blocked', reason: `launch blocked (${block.kind}) — re-probe in ${mins} min. ${block.hint}` };
  }
  return { state: 'probe', reason: `launch probe (${block.kind}) — attempt ${(block.attempts ?? 0) + 1}` };
}

/**
 * Terminal-reason taxonomy for a finalized job row (issue #11 list A2). A
 * closed set so operators never have to open a transcript to tell a
 * non-start from an implementation failure from a verifier downgrade.
 */
function deriveTerminalReason({ effectiveStatus, exitCode, verifyResult, sigtermOverride, worktreeIntegrationFailure }) {
  if (worktreeIntegrationFailure) return 'worktree_integration_failed';
  if (effectiveStatus === 'completed') return 'completed';
  if (sigtermOverride) return 'signal_kill_with_commit';
  if (exitCode === 143 || exitCode === 137) return 'signal_kill';
  if (typeof exitCode === 'number' && exitCode !== 0) return `impl_failed:exit_${exitCode}`;
  if (effectiveStatus === 'needs_review' && verifyResult && verifyResult.verdict) return `verifier:${verifyResult.verdict}`;
  return effectiveStatus || 'unknown';
}

/**
 * Write the per-run `<slug>.outcome.json` sidecar (issue #11 list B5): the
 * handful of numbers that make fleet health computable without parsing
 * transcripts. Best-effort, never throws.
 */
function writeOutcomeSidecar(runDir, slug, outcome) {
  if (!runDir || !slug) return null;
  const p = path.join(runDir, `${slug}.outcome.json`);
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ slug, writtenAt: new Date().toISOString(), ...outcome }, null, 2));
    fs.renameSync(tmp, p);
    return p;
  } catch {
    return null;
  }
}

module.exports = {
  LAUNCH_FAILURE_KINDS,
  LAUNCH_BLOCK_MAX_ATTEMPTS,
  LAUNCH_PROBE_STALE_MS,
  parseResultEvent,
  readResultEvent,
  extractApiMessage,
  classifyLaunchFailure,
  resultShowsRealTurn,
  backoffMsFor,
  mitigationEnvFor,
  launchBlockKeyFor,
  launchFailureHint,
  armLaunchBlock,
  evaluateLaunchGate,
  deriveTerminalReason,
  writeOutcomeSidecar,
};
