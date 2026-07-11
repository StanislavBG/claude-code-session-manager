'use strict';

/**
 * mcpStatus.cjs — probes live MCP server connection status by shelling out to
 * `claude mcp list` (a plain subcommand, no LLM call — no --model pin needed).
 *
 * Read-only, non-polling: only runs on explicit renderer request (mcp:status
 * IPC). Coalesces concurrent callers onto a single in-flight probe so bursts
 * don't fan out into parallel `claude` processes.
 */

const { spawn } = require('node:child_process');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');

const PROBE_TIMEOUT_MS = 30_000;

// One server line: "<name>: <target> - <glyph> <status text>"
const LINE_RE = /^(.+?):\s(.+?)\s-\s(\S+)\s*(.*)$/;

/**
 * Pure parser — no I/O. Extracts { name, target, transport, status } per
 * server line. Ignores the "Checking MCP server health…" header and blank
 * lines. Never throws: unparseable input yields [].
 */
function parseMcpList(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const servers = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith('checking mcp server health')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, name, target, glyph, statusText] = m;
    const transport = /\(HTTP\)$/.test(target) || /^https?:\/\//i.test(target) ? 'http' : 'stdio';
    let status;
    if (glyph === '✔') status = 'connected';
    else if (glyph === '✘') status = 'failed';
    else if (glyph === '!') status = 'needs-auth';
    else if (glyph === '⏸') status = 'pending';
    else status = 'unknown';
    servers.push({ name: name.trim(), target: target.trim(), transport, status, statusText: statusText.trim() });
  }
  return servers;
}

let inFlight = null;

/** Spawns `claude mcp list`, parses it. Resolves — never rejects. */
function runProbe() {
  return new Promise((resolve) => {
    let bin;
    try { bin = resolveClaudeBin(); } catch (e) {
      resolve({ ok: false, servers: [], error: `claude not found: ${e?.message}`, checkedAt: Date.now() });
      return;
    }
    let child;
    try {
      child = spawn(bin, ['mcp', 'list'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, servers: [], error: e?.message || 'spawn error', checkedAt: Date.now() });
      return;
    }
    let out = '';
    let err = '';
    const MAX_OUT_BYTES = 1 * 1024 * 1024;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      finish({ ok: false, servers: [], error: 'timeout', checkedAt: Date.now() });
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT_BYTES) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT_BYTES) err += d; });
    child.on('error', (e) => { finish({ ok: false, servers: [], error: e?.message || 'spawn error', checkedAt: Date.now() }); });
    child.on('close', (code) => {
      if (code !== 0 && !out) {
        finish({ ok: false, servers: [], error: err.slice(0, 500) || `exit ${code}`, checkedAt: Date.now() });
        return;
      }
      finish({ ok: true, servers: parseMcpList(out), checkedAt: Date.now() });
    });
  });
}

/** Public entry point. Coalesces concurrent callers onto one in-flight probe. */
function probeMcpStatus() {
  if (inFlight) return inFlight;
  inFlight = runProbe().finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { probeMcpStatus, parseMcpList };
