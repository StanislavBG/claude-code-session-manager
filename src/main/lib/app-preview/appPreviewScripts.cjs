'use strict';

// Pure helpers for the Epic "Run preview" feature: start the project's dev
// script inside the Epic worktree and open the local URL it prints in the
// system browser (no embedded webview). This module only lists package.json
// scripts, finds the first loopback http(s) URL in dev-server output, and
// allocates a free local TCP port. Spawning and IPC live in later modules.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// First char excludes '-' so a name can never be parsed as an npm flag
// (--inspect); no spaces or shell metacharacters anywhere.
const SCRIPT_NAME_RE = /^[A-Za-z0-9@_][A-Za-z0-9:_.@/-]{0,99}$/;
const MAX_SCRIPTS = 200;
const MAX_COMMAND_CHARS = 500;
const SUGGESTED_ORDER = ['dev', 'start', 'serve', 'preview', 'develop'];

function isValidScriptName(name) {
  return typeof name === 'string' && SCRIPT_NAME_RE.test(name);
}

/** @returns {{ok:true, scripts:{name:string,command:string}[], suggested:string|null} | {ok:false, error:string}} */
function listPreviewScripts(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(String(dir), 'package.json'), 'utf8');
  } catch {
    return { ok: false, error: `No package.json in ${dir}` };
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { ok: false, error: `package.json in ${dir} is not valid JSON` };
  }
  const src = pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg.scripts : null;
  const scripts = [];
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [name, value] of Object.entries(src)) {
      if (scripts.length >= MAX_SCRIPTS) break;
      if (!isValidScriptName(name) || typeof value !== 'string' || value.trim() === '') continue;
      scripts.push({ name, command: value.slice(0, MAX_COMMAND_CHARS) });
    }
  }
  if (scripts.length === 0) return { ok: false, error: `package.json in ${dir} has no runnable scripts` };
  const names = new Set(scripts.map((s) => s.name));
  const suggested = SUGGESTED_ORDER.find((n) => names.has(n)) || null;
  return { ok: true, scripts, suggested };
}

// CSI: ESC [ params intermediates final-byte. OSC: ESC ] ... (BEL | ESC \).
const CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text.replace(OSC_RE, '').replace(CSI_RE, '');
}

const URL_RE = /(?<![A-Za-z0-9+.-])(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::(\d+))?([^\s"'<>]*)/gi;
const TRAILING_RE = /[.,;)]+$/;

/** First loopback http(s) URL in dev-server output, or null. */
function detectLocalUrl(text) {
  const clean = stripAnsi(text);
  if (!clean) return null;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(clean)) !== null) {
    const [, scheme, rawHost, portStr, rawRest] = m;
    const rest = rawRest.replace(TRAILING_RE, '');
    // Host must end here (rejects localhost.evil.com, localhost:3000abc).
    if (rest && !/^[/?#]/.test(rest)) continue;
    if (portStr !== undefined) {
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    }
    const lowerHost = rawHost.toLowerCase();
    const host = lowerHost === '0.0.0.0' || lowerHost === '[::]' ? 'localhost' : lowerHost;
    return `${scheme.toLowerCase()}://${host}${portStr !== undefined ? `:${portStr}` : ''}${rest}`;
  }
  return null;
}

/** Resolves an OS-assigned free port on 127.0.0.1. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

module.exports = {
  SCRIPT_NAME_RE,
  isValidScriptName,
  listPreviewScripts,
  detectLocalUrl,
  stripAnsi,
  findFreePort,
};
