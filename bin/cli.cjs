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
  console.error('[claude-code-session-manager] electron dependency is missing. Reinstall the package.');
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
