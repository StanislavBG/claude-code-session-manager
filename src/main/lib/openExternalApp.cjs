/**
 * openExternalApp.cjs — helpers for launching editor / file manager / terminal.
 *
 * Security invariant: callers (IPC handlers in index.cjs) MUST run containment
 * checks before delegating here. These functions receive already-validated paths.
 *
 * All four functions return:
 *   { ok: true;  opener: string }  — name of the program that was launched
 *   { ok: false; error: string }   — human-readable failure reason
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { shell } = require('electron');
const { cleanChildEnv } = require('./cleanEnv.cjs');

// IMAGE_RE — extensions opened in the OS default viewer, not a code editor.
// Keep in sync with the comment in index.cjs open-file-in-editor handler.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|avif|heic|ico)$/i;

// EDITOR_CANDIDATES — single source for the default editor resolution order (AC #5).
// process.env.VISUAL / EDITOR are read lazily so they pick up any runtime overrides.
const editorCandidates = () =>
  [process.env.VISUAL, process.env.EDITOR, 'code', 'cursor', 'subl', 'nano'].filter(Boolean);

/**
 * Returns the resolved path of a command, or null if not found on $PATH.
 * Moved here from index.cjs (was the only caller of the local helper there).
 */
function findCommand(name) {
  try {
    const out = execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      [name],
      { encoding: 'utf8', env: process.env, timeout: 500 },
    ).trim().split(/\r?\n/)[0];
    if (out) return out;
  } catch { /* not found */ }
  return null;
}

/**
 * Spawn a detached opener and resolve once the OS reports the outcome.
 * A missing/unexecutable binary emits an async 'error' (ENOENT/EACCES); without
 * a listener that is an uncaught exception and the caller would see ok:true.
 * Races 'spawn' against 'error' — never uses shell:true.
 *
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
function spawnDetached(cmd, args, opener = cmd, spawnFn = spawn, extraOpts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', env: cleanChildEnv(), ...extraOpts });
    } catch (e) {
      resolve({ ok: false, error: `failed to launch ${opener}: ${e?.message ?? e}` });
      return;
    }
    child.once('error', (e) => resolve({ ok: false, error: `failed to launch ${opener}: ${e?.message ?? e}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, opener }); });
  });
}

/**
 * Open a project root directory in the user's editor.
 *
 * @param {{ cwd: string, editor?: string | null }} opts
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function openInEditor({ cwd, editor }) {
  const candidates = (editor && editor !== 'auto') ? [editor] : editorCandidates();
  for (const cmd of candidates) {
    if (!findCommand(cmd)) continue;
    return spawnDetached(cmd, [cwd]);
  }
  return { ok: false, error: 'no editor found' };
}

/**
 * Open a specific file (with optional line:col) in the user's editor.
 * Image files are routed to the OS default viewer via shell.openPath.
 *
 * The path MUST already have passed containment checks at the IPC boundary.
 * `abs` must be an absolute path.
 *
 * Goto-line flag behavior (AC #6):
 *   code | cursor | subl  → spawn with ['-g', 'file:line:col']
 *   everything else        → spawn with ['file']  (bare path, no goto support)
 *
 * @param {{ path: string, line?: number, col?: number, editor?: string | null }} opts
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function openFileInEditor({ path: abs, line, col, editor }) {
  try { await fsp.access(abs); } catch { return { ok: false, error: `file not found: ${abs}` }; }

  // Image fast path — use the OS default viewer instead of a code editor.
  // path.basename avoids .tar.gz-style extension ambiguities (AC implementation note).
  if (IMAGE_RE.test(path.basename(abs))) {
    const errStr = await shell.openPath(abs);
    if (errStr) return { ok: false, error: errStr };
    return { ok: true, opener: 'shell' };
  }

  const candidates = (editor && editor !== 'auto') ? [editor] : editorCandidates();
  for (const cmd of candidates) {
    if (!findCommand(cmd)) continue;
    // Only code/cursor/subl understand the -g goto-line flag (AC #6).
    const supportsGoto = /^(code|cursor|subl)$/.test(cmd);
    const target = (supportsGoto && line) ? `${abs}:${line}${col ? `:${col}` : ''}` : abs;
    const args = supportsGoto ? ['-g', target] : [abs];
    return spawnDetached(cmd, args);
  }
  return { ok: false, error: 'no editor found' };
}

/**
 * Open a directory in the OS file manager (Finder on macOS, Nautilus etc on Linux,
 * explorer.exe on Windows).
 *
 * @param {{ cwd: string }} opts
 * @param {{ platform?: string, spawn?: Function }} [deps]
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function openInFinder({ cwd }, deps = {}) {
  const { platform = process.platform, spawn: spawnFn = spawn } = deps;
  if (platform === 'win32') return spawnDetached('explorer.exe', [cwd], 'explorer', spawnFn);
  const errStr = await shell.openPath(cwd);
  if (errStr) return { ok: false, error: errStr };
  return { ok: true, opener: 'shell' };
}

/**
 * Open a terminal emulator in the given directory.
 *
 * Linux: tries gnome-terminal → konsole → xfce4-terminal → xterm.
 * macOS: delegates to Terminal.app via `open -a`.
 * Windows: `wt.exe -d <cwd>` when on PATH, else powershell.exe -NoExit in a new
 * console via `cmd.exe /d /c start`.
 *
 * Arg shapes per terminal are preserved verbatim from index.cjs (AC impl note):
 *   gnome-terminal  → ['--working-directory=<cwd>']
 *   others          → ['-e', "bash -c \"cd '<cwd>' && exec bash\""]
 *
 * @param {{ cwd: string }} opts
 * @param {{ platform?: string, spawn?: Function, findCommand?: (n: string) => string | null }} [deps]
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function openInTerminal({ cwd }, deps = {}) {
  const { platform = process.platform, spawn: spawnFn = spawn, findCommand: find = findCommand } = deps;
  if (platform === 'linux') {
    const terms = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    for (const t of terms) {
      if (!find(t)) continue;
      const args = t === 'gnome-terminal'
        ? ['--working-directory=' + cwd]
        : ['-e', `bash -c "cd '${cwd.replace(/'/g, "'\\''")}' && exec bash"`];
      return spawnDetached(t, args, t, spawnFn);
    }
  } else if (platform === 'darwin') {
    return spawnDetached('open', ['-a', 'Terminal', cwd], 'Terminal.app', spawnFn);
  } else if (platform === 'win32') {
    if (find('wt.exe')) return spawnDetached('wt.exe', ['-d', cwd], 'wt', spawnFn);
    const setLoc = `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`;
    return spawnDetached('cmd.exe',
      ['/d', '/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', setLoc],
      'powershell', spawnFn, { windowsHide: true });
  }
  return { ok: false, error: 'no terminal found' };
}

/** Escape a string for use inside an AppleScript double-quoted literal. */
const appleScriptQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Run a command in a visible OS terminal so the user sees and controls it
 * (password prompts, installer dialogs). `command` MUST come from main-side
 * code, never from the renderer. argv arrays only — never shell:true.
 *
 * @param {{ command: string, shell?: 'sh' | 'powershell' }} opts
 * @param {{ platform?: string, spawn?: Function, find?: (n: string) => string | null }} [deps]
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function runInTerminal({ command, shell: shellKind }, deps = {}) {
  const { platform = process.platform, spawn: spawnFn = spawn, find = findCommand } = deps;
  if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'empty command' };
  if (platform === 'darwin') {
    const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptQuote(command)}\nend tell`;
    return spawnDetached('osascript', ['-e', script], 'Terminal.app', spawnFn);
  }
  if (platform === 'win32') {
    return spawnDetached('cmd.exe',
      ['/d', '/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', command],
      'powershell', spawnFn);
  }
  if (platform === 'linux') {
    const inner = `${command}; exec bash`;
    for (const t of ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']) {
      if (!find(t)) continue;
      const args = t === 'gnome-terminal'
        ? ['--', 'bash', '-lc', inner]
        : ['-e', 'bash', '-lc', inner];
      return spawnDetached(t, args, t, spawnFn);
    }
  }
  return { ok: false, error: 'no terminal found' };
}

module.exports = { spawnDetached, findCommand, openInEditor, openFileInEditor, openInFinder, openInTerminal, runInTerminal };
