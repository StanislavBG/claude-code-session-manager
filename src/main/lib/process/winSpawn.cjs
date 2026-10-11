/**
 * winSpawn.cjs — make spawn() work for Windows .cmd/.bat shims (npx, npm) without
 * shell:true. Node refuses to spawn those directly (EINVAL), so they are wrapped in
 * an explicit `cmd.exe /d /s /c "<line>"` argv with every cmd metacharacter escaped.
 * Non-win32 input passes through untouched.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const META = /([()\][%!^"`<>&|;, *?])/g;

function envGet(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function findOnPath(command, env, exists) {
  const w = path.win32;
  const exts = (envGet(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';').filter(Boolean).map((e) => e.toLowerCase());
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir ? [''] : (envGet(env, 'PATH') || '').split(';').filter(Boolean);
  const hasExt = exts.includes(w.extname(command).toLowerCase());
  for (const dir of dirs) {
    const base = dir ? w.join(dir, command) : command;
    const candidates = hasExt ? [base] : [];
    for (const e of exts) candidates.push(base + e);
    // PATHEXT order is by extension; keep the casing the filesystem probe accepts.
    for (const cand of candidates) {
      if (exists(cand)) return cand;
      const upper = cand.slice(0, cand.length - w.extname(cand).length) + w.extname(cand).toUpperCase();
      if (upper !== cand && exists(upper)) return upper;
    }
  }
  return null;
}

// Quote for CreateProcess argv parsing, then ^-escape every cmd metacharacter.
function quoteArg(arg) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  return s.replace(META, '^$1');
}

function resolveSpawn(command, args = [], { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return { command, args };
  const resolved = findOnPath(command, env, exists);
  if (!resolved) return { command, args };
  const ext = path.win32.extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const line = [resolved, ...args].map(quoteArg).join(' ');
    return {
      command: envGet(env, 'ComSpec') || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args };
}

module.exports = { resolveSpawn };
