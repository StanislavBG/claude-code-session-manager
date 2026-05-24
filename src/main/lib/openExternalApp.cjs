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
 * Open a project root directory in the user's editor.
 *
 * @param {{ cwd: string, editor?: string | null }} opts
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function openInEditor({ cwd, editor }) {
  const candidates = (editor && editor !== 'auto') ? [editor] : editorCandidates();
  for (const cmd of candidates) {
    if (!findCommand(cmd)) continue;
    spawn(cmd, [cwd], { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
    return { ok: true, opener: cmd };
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
    spawn(cmd, args, { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
    return { ok: true, opener: cmd };
  }
  return { ok: false, error: 'no editor found' };
}

/**
 * Open a directory in the OS file manager (Finder on macOS, Nautilus etc on Linux).
 *
 * @param {{ cwd: string }} opts
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function openInFinder({ cwd }) {
  const errStr = await shell.openPath(cwd);
  if (errStr) return { ok: false, error: errStr };
  return { ok: true, opener: 'shell' };
}

/**
 * Open a terminal emulator in the given directory.
 *
 * Linux: tries gnome-terminal → konsole → xfce4-terminal → xterm.
 * macOS: delegates to Terminal.app via `open -a`.
 *
 * Arg shapes per terminal are preserved verbatim from index.cjs (AC impl note):
 *   gnome-terminal  → ['--working-directory=<cwd>']
 *   others          → ['-e', "bash -c \"cd '<cwd>' && exec bash\""]
 *
 * @param {{ cwd: string }} opts
 * @returns {Promise<{ ok: true, opener: string } | { ok: false, error: string }>}
 */
async function openInTerminal({ cwd }) {
  if (process.platform === 'linux') {
    const terms = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    for (const t of terms) {
      if (!findCommand(t)) continue;
      const args = t === 'gnome-terminal'
        ? ['--working-directory=' + cwd]
        : ['-e', `bash -c "cd '${cwd.replace(/'/g, "'\\''")}' && exec bash"`];
      spawn(t, args, { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
      return { ok: true, opener: t };
    }
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
    return { ok: true, opener: 'Terminal.app' };
  }
  return { ok: false, error: 'no terminal found' };
}

module.exports = { findCommand, openInEditor, openFileInEditor, openInFinder, openInTerminal };
