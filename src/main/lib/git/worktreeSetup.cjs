/**
 * worktreeSetup.cjs — run a project's one-time warm-up commands in a fresh
 * worktree (e.g. Godot's first `--import` core-dumps; the second is clean).
 *
 * The project declares them in a TRACKED `.session-manager.json` at its root:
 *   { "worktreeSetup": ["timeout 600 godot --headless --path game --import"] }
 * Entries use gate syntax, are validated by prdGateFiles.validateGate, and run
 * in order with cwd = the WORKTREE ROOT, so a project whose code lives in a
 * subfolder names it itself (Godot's `--path game`).
 *
 * Execution: definitionOfDone.runIsolatedSequence — it never takes the shadow
 * gate flag, so a setup is never skipped as "busy" and never makes a gate busy.
 * Setups of the same project (key = path.resolve(mainCwd || worktreeCwd)) run
 * strictly one at a time: a later call waits and is never skipped. Different
 * projects run in parallel.
 *
 * Never throws. Always resolves to one outcome object:
 *   { ran, ok, reason, error?, waitedMs, ms, commands }
 *   commands: one { cmd, status, code, ms, timedOut, tail } per started command
 *             (tail <= 1000 chars). ok is true only when every command passed.
 *   reason when commands ran: 'passed' | 'failed' | 'unavailable'
 *   reason otherwise: 'no-config' | 'not-in-worktree' | 'unreadable' |
 *     'not-declared' | 'invalid' | 'opt-out' | 'no-commands' | 'error'
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { validateGate } = require('../prd/prdGateFiles.cjs');
const { parseChain, runIsolatedSequence } = require('../scheduler/definitionOfDone.cjs');

const CONFIG_NAME = '.session-manager.json';
const TAIL_MAX = 1000;

/** Per-project chain of in-flight setups; idle keys are deleted. */
const setupChains = new Map();

function log(msg) {
  try { console.warn(`[worktreeSetup] ${msg}`); } catch { /* best-effort */ }
}

function skipped(reason, extra) {
  return { ran: false, ok: false, reason, waitedMs: 0, ms: 0, commands: [], ...extra };
}

/** True when mainCwd's config declares a real (non-empty, non-"none") worktreeSetup. */
function mainDeclaresSetup(mainCwd) {
  if (typeof mainCwd !== 'string' || !mainCwd) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(mainCwd, CONFIG_NAME), 'utf8'));
    const ws = cfg && cfg.worktreeSetup;
    if (!Array.isArray(ws) || !ws.length) return false;
    if (ws.length === 1 && typeof ws[0] === 'string' && /^none$/i.test(ws[0].trim())) return false;
    return true;
  } catch { return false; }
}

/**
 * Resolve the sequence to run, or a skipped outcome.
 * @returns {{ sequence: any[] } | { outcome: object }}
 */
function resolveConfig(worktreeCwd, mainCwd) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(worktreeCwd, CONFIG_NAME), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (mainDeclaresSetup(mainCwd)) {
        log(`${CONFIG_NAME} declares worktreeSetup in the main checkout but is not in this worktree's commit — commit it`);
        return { outcome: skipped('not-in-worktree') };
      }
      return { outcome: skipped('no-config') };
    }
    const msg = String(err && err.message);
    log(`${CONFIG_NAME} unreadable, setup skipped: ${msg}`);
    return { outcome: skipped('unreadable', { error: msg }) };
  }
  if (!cfg || typeof cfg !== 'object' || !('worktreeSetup' in cfg)) return { outcome: skipped('not-declared') };
  if (!Array.isArray(cfg.worktreeSetup)) {
    const error = 'worktreeSetup must be an array of gate-syntax strings';
    log(`invalid worktreeSetup, skipped: ${error}`);
    return { outcome: skipped('invalid', { error }) };
  }
  const v = validateGate(cfg.worktreeSetup);
  if (!v.ok) {
    log(`invalid worktreeSetup, skipped: ${v.error}`);
    return { outcome: skipped('invalid', { error: v.error }) };
  }
  if (v.commands.length === 1 && /^none$/i.test(v.commands[0])) return { outcome: skipped('opt-out') };
  const sequence = [];
  for (const chain of v.commands) sequence.push(...parseChain(chain));
  if (!sequence.length) return { outcome: skipped('no-commands') };
  return { sequence };
}

async function execute(sequence, worktreeCwd, startedAt) {
  const t0 = Date.now();
  const res = await runIsolatedSequence(sequence, { cwd: worktreeCwd });
  const results = Array.isArray(res.results) ? res.results : [];
  const commands = results.map((r, i) => ({
    cmd: sequence[i]?.raw ?? r.cmd,
    status: r.status,
    code: r.code,
    ms: r.ms,
    timedOut: r.timedOut,
    tail: typeof r.tail === 'string' ? r.tail.slice(-TAIL_MAX) : r.tail,
  }));
  const reason = res.status === 'green' ? 'passed' : res.status === 'red' ? 'failed' : 'unavailable';
  if (reason !== 'passed') {
    const last = commands[commands.length - 1] || {};
    log(`setup ${reason}: ${last.cmd ?? '(no command started)'} (exit ${last.code ?? 'n/a'}, ${last.status ?? res.status})`);
  }
  return {
    ran: commands.length > 0,
    ok: reason === 'passed',
    reason,
    waitedMs: t0 - startedAt,
    ms: Date.now() - t0,
    commands,
  };
}

/**
 * @param {{ worktreeCwd: string, mainCwd?: string }} opts
 * @returns {Promise<{ ran: boolean, ok: boolean, reason: string, error?: string, waitedMs: number, ms: number, commands: object[] }>}
 */
async function runWorktreeSetup(opts) {
  try {
    const { worktreeCwd, mainCwd } = opts || {};
    if (typeof worktreeCwd !== 'string' || !worktreeCwd) return skipped('no-config');
    const cfg = resolveConfig(worktreeCwd, mainCwd);
    if (cfg.outcome) return cfg.outcome;

    const key = path.resolve(mainCwd || worktreeCwd);
    const startedAt = Date.now();
    const prev = setupChains.get(key) || Promise.resolve();
    const mine = prev.catch(() => {}).then(() => execute(cfg.sequence, worktreeCwd, startedAt));
    setupChains.set(key, mine);
    try {
      return await mine;
    } finally {
      if (setupChains.get(key) === mine) setupChains.delete(key);
    }
  } catch (err) {
    const error = String(err && err.message);
    log(`unexpected error: ${error}`);
    return skipped('error', { error });
  }
}

const LINE_PREFIX = '[scheduler] worktree setup:';
const LINE_MAX = 500;
/** Reasons that mean "nothing to log" (no setup applies). */
const SILENT_REASONS = new Set(['no-config', 'in-place']);
/** Skip reasons where the worktree is still trustworthy for a gate. */
const SETTLED_REASONS = new Set(['no-config', 'not-declared', 'opt-out']);

function clip(line) {
  return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1)}…`;
}
const secs = (ms) => (Math.round((Number(ms) || 0) / 100) / 10).toString();

/**
 * Run-log lines for a setup outcome. Pure; never throws. Lines are
 * `[scheduler]`-prefixed and never carry command output (tails stay in
 * meta.json) so the run-log detectors cannot be tripped by a setup command.
 * @param {any} outcome
 * @returns {string[]}
 */
function formatSetupOutcome(outcome) {
  try {
    if (!outcome || typeof outcome !== 'object') return [];
    const reason = String(outcome.reason);
    if (SILENT_REASONS.has(reason)) return [];
    if (!outcome.ran) {
      let line = `${LINE_PREFIX} skipped — ${reason}`;
      if (outcome.error) line += `: ${String(outcome.error)}`;
      const lines = [clip(line)];
      if (reason === 'not-in-worktree') {
        lines.push(clip(`${LINE_PREFIX} .session-manager.json is in the main checkout but not in this worktree's commit`));
      }
      return lines;
    }
    const commands = Array.isArray(outcome.commands) ? outcome.commands : [];
    let summary = `${LINE_PREFIX} ${reason} — ${commands.length} command(s) in ${secs(outcome.ms)}s`;
    if (Number(outcome.waitedMs) >= 1000) summary += `, waited ${secs(outcome.waitedMs)}s`;
    const lines = [clip(summary)];
    for (const c of commands) {
      const cc = c && typeof c === 'object' ? c : {};
      const code = cc.code === null || cc.code === undefined ? 'n/a' : String(cc.code);
      lines.push(clip(`${LINE_PREFIX}   exit ${code} in ${Number(cc.ms) || 0}ms${cc.timedOut ? ', timed out' : ''}: ${String(cc.cmd ?? '')}`));
    }
    if (outcome.ok === false) {
      lines.push(clip(`${LINE_PREFIX} output tail is in the run's meta.json under worktreeSetup.commands[].tail`));
    }
    return lines;
  } catch { return []; }
}

/**
 * True when a gate can trust the worktree: setup passed, or none is declared.
 * @param {any} outcome
 * @returns {boolean}
 */
function isSetupSettled(outcome) {
  try {
    if (!outcome || typeof outcome !== 'object') return false;
    return outcome.ok === true || SETTLED_REASONS.has(outcome.reason);
  } catch { return false; }
}

module.exports = { runWorktreeSetup, formatSetupOutcome, isSetupSettled, CONFIG_NAME };
