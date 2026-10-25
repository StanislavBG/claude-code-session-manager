/**
 * worktreeSetup.cjs — run a project's one-time warm-up commands in a fresh
 * worktree (e.g. Godot's first `--import` core-dumps; the second is clean).
 *
 * The project declares them in a tracked `.session-manager.json` at its root:
 *   { "worktreeSetup": ["timeout 600 godot --headless --import"] }
 * Entries use gate syntax, are validated by prdGateFiles.validateGate, and run
 * in order with cwd = the worktree through definitionOfDone.runGateSequence.
 * Best-effort: never throws; failures are logged and returned.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { validateGate } = require('../prd/prdGateFiles.cjs');
const { parseChain, runGateSequence } = require('../scheduler/definitionOfDone.cjs');

const CONFIG_NAME = '.session-manager.json';

function log(msg) {
  try { console.warn(`[worktreeSetup] ${msg}`); } catch { /* best-effort */ }
}

/**
 * @param {{ worktreeCwd: string }} opts
 * @returns {Promise<{ ran: false, error?: string } | { ran: true, ok: boolean }>}
 */
async function runWorktreeSetup({ worktreeCwd }) {
  try {
    if (typeof worktreeCwd !== 'string' || !worktreeCwd) return { ran: false };
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(worktreeCwd, CONFIG_NAME), 'utf8'));
    } catch (err) {
      if (err && err.code !== 'ENOENT') log(`${CONFIG_NAME} unreadable, treated as absent: ${err.message}`);
      return { ran: false };
    }
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.worktreeSetup)) return { ran: false };

    const v = validateGate(cfg.worktreeSetup);
    if (!v.ok) {
      log(`invalid worktreeSetup, skipped: ${v.error}`);
      return { ran: false, error: v.error };
    }
    // "none" is the gate opt-out: nothing to run.
    if (v.commands.length === 1 && /^none$/i.test(v.commands[0])) return { ran: false };

    const sequence = [];
    for (const chain of v.commands) sequence.push(...parseChain(chain));
    if (!sequence.length) return { ran: false, error: 'worktreeSetup produced no runnable commands' };

    const res = await runGateSequence(sequence, { cwd: worktreeCwd });
    if (res.status === 'green') return { ran: true, ok: true };
    if (res.status === 'busy') {
      log('gate runner busy, setup skipped');
      return { ran: false, error: 'gate runner busy' };
    }
    const last = res.results[res.results.length - 1] || {};
    const cmd = sequence[res.results.length - 1]?.raw ?? '(unknown)';
    log(`setup command failed: ${cmd} (exit ${last.code ?? 'n/a'}, ${last.status ?? res.status})`);
    return { ran: true, ok: false };
  } catch (err) {
    log(`unexpected error: ${err && err.message}`);
    return { ran: false, error: String(err && err.message) };
  }
}

module.exports = { runWorktreeSetup, CONFIG_NAME };
