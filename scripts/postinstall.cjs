#!/usr/bin/env node
'use strict';

/**
 * postinstall — rebuild node-pty against the bundled Electron's ABI.
 *
 * The terminal needs node-pty's native binary to match the Electron we ship.
 * We run electron-rebuild, but a failure here MUST NOT fail `npm i -g` — that
 * would block the entire app (config tabs, scheduler, etc.) over one native
 * module. So we run it best-effort and, on failure, print the exact manual fix
 * and exit 0. pty.cjs surfaces the same guidance in-app if a tab can't start.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Resolve the electron-rebuild bin from THIS package's own node_modules first,
// so a global install never has `npx` reach out to the registry (and risk
// pulling the wrong/deprecated `electron-rebuild` package). Fall back to npx.
function rebuildArgv() {
  const pkgRoot = path.join(__dirname, '..');
  const local = path.join(pkgRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
  if (fs.existsSync(local)) return [local, ['-f', '-w', 'node-pty']];
  return [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-rebuild', '-f', '-w', 'node-pty']];
}

function run() {
  const [cmd, args] = rebuildArgv();
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  return r.status === 0 && !r.error;
}

if (run()) process.exit(0);

const mac = process.platform === 'darwin';
const bar = '─'.repeat(64);
console.warn(`\n${bar}`);
console.warn('claude-code-session-manager: node-pty rebuild did not complete.');
console.warn('The app will still launch, but terminal tabs may not start until');
console.warn('the native module is rebuilt for this Electron. To fix it:');
console.warn('');
console.warn('  cd "' + __dirname.replace(/\/scripts$/, '') + '"');
console.warn('  npx electron-rebuild -f -w node-pty');
if (mac) {
  console.warn('');
  console.warn('  # macOS: if the rebuild fails, install the compiler first:');
  console.warn('  xcode-select --install');
}
console.warn(`${bar}\n`);
// Exit 0 — never fail the install over the terminal native module.
process.exit(0);
