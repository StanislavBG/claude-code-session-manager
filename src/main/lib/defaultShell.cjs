'use strict';

const path = require('node:path');

/**
 * Pick the interactive shell for a terminal tab. Pure: every host fact comes in
 * through `platform` / `env` / `exists` so it is testable for any OS.
 *
 * win32: PowerShell 7 (`pwsh.exe`) when found on PATH or under
 * %ProgramFiles%\PowerShell\7, else the Windows PowerShell 5.1 that ships with
 * every install. POSIX: `$SHELL` (or /bin/bash) as an interactive login shell.
 *
 * @param {{ platform: string, env: Record<string, string | undefined>, exists: (p: string) => boolean }} opts
 * @returns {{ file: string, args: string[] }}
 */
function defaultShell({ platform, env, exists }) {
  if (platform !== 'win32') {
    return { file: env.SHELL || '/bin/bash', args: ['-il'] };
  }
  const w = path.win32;
  const pathDirs = (env.PATH || env.Path || '').split(';').filter(Boolean);
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    ...pathDirs.map((d) => w.join(d, 'pwsh.exe')),
    w.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
  ];
  const pwsh = candidates.find((p) => exists(p));
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  return {
    file: w.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo'],
  };
}

module.exports = { defaultShell };
