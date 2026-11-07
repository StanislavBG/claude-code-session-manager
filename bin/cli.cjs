#!/usr/bin/env node
/**
 * npx launcher for claude-code-session-manager.
 * Spawns the Electron binary on the package root so main: src/main/index.cjs boots.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { nodeFloor, isBelow } = require('./node-floor.cjs');

let electronBin;
try {
  electronBin = require('electron');
} catch (err) {
  // `require('electron')` downloads its ~100MB binary from GitHub releases on first use.
  // Electron 42's downloader (@electron/get 5) is ESM-only, so below Node 22.12 it can't
  // even load (ERR_REQUIRE_ESM). Name that cause instead of blaming the network. Checked
  // only after a failure: an already-downloaded binary still launches on older Node.
  const floor = nodeFloor();
  if (floor && isBelow(process.versions.node, floor)) {
    console.error(`[claude-code-session-manager] Node.js ${floor.join('.')} or newer is required — this is Node ${process.versions.node}.`);
    console.error('Electron, which this app runs on, cannot download itself on older Node. Upgrade Node, then re-run:');
    console.error('  npx claude-code-session-manager@latest');
    process.exit(1);
  }
  // Otherwise a failure here almost always means that download didn't complete (flaky
  // network, a corporate proxy/firewall blocking GitHub release downloads, low disk space) —
  // not a bug in this package. Point at the likely causes and a retry path instead of just
  // "reinstall" (gh-9).
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

const sup = require('./supervise.cjs');
const { chooseOzonePlatform } = require('../src/main/lib/process/ozonePlatform.cjs');

const appRoot = path.join(__dirname, '..');
const dir = sup.logsDir();
// A closed launcher stderr (EPIPE) must not kill the supervisor.
process.stderr.on('error', () => { /* ignore */ });

let forwardedSignal = null;
let respawns = [];
let current = null;

// --ozone-platform must be on Electron's real argv: appendSwitch from the main script runs after
// Electron has picked its platform. An explicit launcher arg wins and is never duplicated.
function ozoneArgs(args) {
  if (args.some((a) => a === '--ozone-platform' || a.startsWith('--ozone-platform='))) return [];
  let choice = null;
  try { choice = chooseOzonePlatform(process.env); } catch { /* default platform */ }
  return choice ? [`--ozone-platform=${choice}`] : [];
}

// The child's 'close' waits for every holder of its stderr pipe, and Electron's
// chrome_crashpad_handler inherits that pipe as fd 2 and can outlive the main process — so
// 'close' may never fire. Decide on 'exit'; wait this long for 'close' to flush the stderr tail.
const CLOSE_GRACE_MS = 2000;

function launch() {
  const startedAt = Date.now();
  const userArgs = process.argv.slice(2);
  const child = spawn(electronBin, [...ozoneArgs(userArgs), appRoot, ...userArgs], {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: process.env,
  });
  current = child;
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      try { process.stderr.write(chunk); } catch { /* ignore */ }
      sup.appendStderr(dir, chunk);
    });
  }
  // Record the exit, then respawn or exit — exactly once per child.
  let settled = false;
  function settle(code, signal, exitedAt) {
    if (settled) return;
    settled = true;
    // An orphaned holder of the pipe must not keep this launcher alive.
    try { if (child.stderr) child.stderr.destroy(); } catch { /* ignore */ }
    try {
      sup.recordExit(dir, {
        ts: new Date(exitedAt).toISOString(), pid: child.pid, code, signal, uptimeMs: exitedAt - startedAt,
      });
    } catch { /* best-effort */ }
    let again = false;
    try {
      again = sup.shouldRespawn({ code, signal, forwardedSignal, sentinel: sup.readSentinel(dir), childPid: child.pid });
    } catch { /* never block exit */ }
    if (again) {
      const guard = sup.checkCrashLoop(respawns, Date.now());
      respawns = guard.timestamps;
      again = guard.allow;
    }
    if (again) {
      console.error(`[claude-code-session-manager] Electron exited unclean (code=${code} signal=${signal}); respawning in ${sup.RESPAWN_DELAY_MS / 1000}s`);
      setTimeout(launch, sup.RESPAWN_DELAY_MS);
      return;
    }
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  }

  child.on('exit', (code, signal) => {
    const exitedAt = Date.now();
    const grace = setTimeout(() => settle(code, signal, exitedAt), CLOSE_GRACE_MS);
    child.once('close', () => { clearTimeout(grace); settle(code, signal, exitedAt); });
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    forwardedSignal = sig;
    if (current && current.exitCode === null && current.signalCode === null) {
      try { current.kill(sig); } catch { /* ignore */ }
    } else {
      process.exit(0);
    }
  });
}

launch();
