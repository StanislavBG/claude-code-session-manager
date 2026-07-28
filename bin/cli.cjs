#!/usr/bin/env node
/**
 * npx launcher for claude-code-session-manager.
 * Spawns the Electron binary on the package root so main: src/main/index.cjs boots.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.error('[claude-code-session-manager] Windows is not supported yet.');
  process.exit(1);
}

let electronBin;
try {
  electronBin = require('electron');
} catch (err) {
  // `electron`'s own postinstall downloads its ~100MB binary from GitHub releases; a failure
  // here almost always means that download didn't complete (flaky network, a corporate
  // proxy/firewall blocking GitHub release downloads, low disk space) — not a bug in this
  // package. Point at the likely causes and a retry path instead of just "reinstall" (gh-9).
  console.error('[claude-code-session-manager] electron dependency is missing — its binary download did not complete.');
  console.error('This is usually a network issue, not a problem with this package. Try:');
  console.error('  1. Re-run: npx claude-code-session-manager@latest (retries the download)');
  console.error('  2. If you are behind a corporate proxy/firewall, ensure it allows downloads from');
  console.error('     https://github.com/electron/electron/releases (or set ELECTRON_MIRROR to an');
  console.error('     internal mirror if your org provides one)');
  console.error('  3. Check available disk space');
  console.error('If none of that helps, please open an issue with the exact npm/npx output.');
  process.exit(1);
}

const appRoot = path.join(__dirname, '..');
const child = spawn(electronBin, [appRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
