'use strict';

/**
 * runClaudeP.cjs — shared cost-gated `claude -p` spawn/capture helper.
 *
 * Extracted from memoryAggregate.cjs's runClaude (PRD 356) so every
 * cost-gated synthesis caller (Memory Clusters, the Project Brief) shares one
 * spawn/timeout/output-cap implementation instead of forking it per feature.
 *
 * Pattern: stdin closed ('ignore' — `claude -p` blocks forever waiting for
 * piped stdin otherwise), model pinned explicitly by the caller, hard
 * timeout that resolves {ok:false} rather than hanging, SM_KG_INTERNAL=1 so
 * the prompt-logging hook skips these internal calls, and an output-size cap
 * so a runaway response can't grow `out` unbounded.
 */

const { spawn } = require('node:child_process');
const { resolveClaudeBin } = require('./claudeBin.cjs');

const MAX_OUT_BYTES = 8 * 1024 * 1024;

/** Spawn `claude -p`, capture stdout. Resolves {ok, out, error} — never throws. */
function runClaudeP(prompt, { model = 'sonnet', timeoutMs = 180_000, systemPrompt = null } = {}) {
  return new Promise((resolve) => {
    let bin;
    try { bin = resolveClaudeBin(); } catch (e) { resolve({ ok: false, error: `claude not found: ${e?.message}` }); return; }
    const args = [
      '-p', prompt,
      '--model', model,
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ];
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    const child = spawn(bin, args, { env: { ...process.env, SM_KG_INTERNAL: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killedForSize = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } resolve({ ok: false, error: 'timeout', out }); }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length > MAX_OUT_BYTES) {
        if (!killedForSize) { killedForSize = true; try { child.kill('SIGKILL'); } catch { /* */ } }
        return;
      }
      out += d;
    });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT_BYTES) err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e?.message || 'spawn error' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
  });
}

module.exports = { runClaudeP };
