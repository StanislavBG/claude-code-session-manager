'use strict';
/**
 * preflightCheck — the optional PRD precondition command (`preflight`).
 *
 * A PRD whose work needs an external precondition a person controls (a store
 * agreement, billing, DNS, OAuth consent) declares one cheap, read-only
 * command. The scheduler holds the job while it exits non-zero and resumes it
 * once it exits 0. This module is the pure-plus-runner core; wiring lives in
 * the scheduler.
 *
 * No second gate grammar: a preflight is validated by prdGateFiles'
 * validateGate (as a one-entry gate) and run by definitionOfDone's
 * runIsolatedSequence — the same no-shell tokenizer + spawner the gate shadow
 * uses. The read-only contract is not enforced beyond that validator.
 */

const { validateGate } = require('../prd/prdGateFiles.cjs');
const { parseChain, isNoneGate, runIsolatedSequence } = require('./definitionOfDone.cjs');

const PREFLIGHT_MAX_CHARS = 500;
const OUTPUT_TAIL_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_MS = 60 * 1000;
const DELAY_LADDER_MS = [10 * MIN_MS, 20 * MIN_MS, 40 * MIN_MS, 60 * MIN_MS];

/**
 * @param {unknown} value
 * @returns {string|null} trimmed command, or null when empty/absent.
 * @throws {Error} for a multi-line, over-long or gate-invalid value.
 */
function normalizePreflight(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('preflight must be a string command.');
  const cmd = value.trim();
  if (!cmd) return null;
  if (/[\r\n]/.test(cmd)) throw new Error('preflight must be one line (no newline).');
  if (cmd.length > PREFLIGHT_MAX_CHARS) {
    throw new Error(`preflight must be at most ${PREFLIGHT_MAX_CHARS} chars (got ${cmd.length}).`);
  }
  if (isNoneGate(cmd)) throw new Error('preflight "none" is not a command — omit preflight instead.');
  const v = validateGate([cmd]);
  if (!v.ok) throw new Error(`preflight is not a valid command: ${v.error.replace(/^gate /, '')}`);
  return cmd;
}

/** Re-check delay for the Nth failed check: 10, 20, 40, then 60 minutes. */
function preflightDelayMs(attempt) {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  return DELAY_LADDER_MS[Math.min(n, DELAY_LADDER_MS.length) - 1];
}

/**
 * Run the preflight command once, without a shell.
 * Every step's timeout is capped at timeoutMs.
 *
 * @returns {Promise<{ok:boolean, exitCode:number|null, timedOut:boolean, outputTail:string}>}
 */
async function runPreflight({ command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const steps = typeof command === 'string' ? parseChain(command.trim()) : [];
  if (!steps.length) {
    return { ok: false, exitCode: null, timedOut: false, outputTail: 'preflight command could not be parsed' };
  }
  const sequence = steps.map((s) => ({ ...s, timeoutMs: Math.min(s.timeoutMs, timeoutMs) }));
  const r = await runIsolatedSequence(sequence, { cwd });
  const results = Array.isArray(r.results) ? r.results : [];
  const last = results[results.length - 1];
  const combined = results.map((x) => x.outputTail || '').join('');
  const timedOut = results.some((x) => x.timedOut === true);
  return {
    ok: r.status === 'green' && !timedOut,
    exitCode: last && typeof last.code === 'number' ? last.code : null,
    timedOut,
    outputTail: combined.slice(-OUTPUT_TAIL_CHARS),
  };
}

/**
 * Next hold state after a failed preflight check.
 *
 * @param {object|null|undefined} prev previous hold (or none)
 * @param {{exitCode:number|null, outputTail:string}} result runPreflight result
 * @param {number} now epoch ms
 * @param {string} failText the person-facing "what to do" text
 */
function armPreflightHold(prev, result, now, failText) {
  const attempts = prev && Number.isFinite(prev.attempts) ? prev.attempts + 1 : 1;
  return {
    since: prev && prev.since ? prev.since : new Date(now).toISOString(),
    attempts,
    nextAt: new Date(now + preflightDelayMs(attempts)).toISOString(),
    lastExit: result && typeof result.exitCode === 'number' ? result.exitCode : null,
    lastOutputTail: result && typeof result.outputTail === 'string' ? result.outputTail : '',
    failText,
  };
}

module.exports = { normalizePreflight, preflightDelayMs, runPreflight, armPreflightHold };
