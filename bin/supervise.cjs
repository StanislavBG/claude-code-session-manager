/**
 * Pure-ish helpers for bin/cli.cjs: record each Electron exit, keep stderr on disk,
 * decide whether to respawn. Everything touching disk is best-effort and never throws.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = 'claude-code-session-manager';
const EXIT_LOG = 'main-exit.jsonl';
const STDERR_LOG = 'electron-stderr.log';
const SENTINEL = 'last-run.json';
const MAX_EXIT_LINES = 200;
const MAX_STDERR_BYTES = 5 * 1024 * 1024;
const RESPAWN_DELAY_MS = 2000;
const MAX_RESPAWNS = 5;
const RESPAWN_WINDOW_MS = 10 * 60 * 1000;

function logsDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SM_LOGS_DIR) return env.SM_LOGS_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_DIR, 'logs');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR, 'logs');
  return path.join(home, '.config', APP_DIR, 'logs');
}

/** Append one line to a file, keeping only the last `max` lines. */
function appendCappedLine(file, line, max = MAX_EXIT_LINES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* new file */ }
    lines.push(line);
    if (lines.length > max) lines = lines.slice(lines.length - max);
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch { /* best-effort */ }
}

function recordExit(dir, entry, max = MAX_EXIT_LINES) {
  appendCappedLine(path.join(dir, EXIT_LOG), JSON.stringify(entry), max);
}

/** Rotate file -> file.1 when it has reached maxBytes. */
function rotateIfNeeded(file, maxBytes = MAX_STDERR_BYTES) {
  try {
    if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, file + '.1');
  } catch { /* missing file or race: nothing to rotate */ }
}

function appendStderr(dir, chunk, maxBytes = MAX_STDERR_BYTES) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, STDERR_LOG);
    rotateIfNeeded(file, maxBytes);
    fs.appendFileSync(file, chunk);
  } catch { /* best-effort */ }
}

function readSentinel(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, SENTINEL), 'utf8')); } catch { return null; }
}

/**
 * Respawn only after an unclean exit: the sentinel still says open:true for this
 * child's pid. Clean exits and signals the launcher forwarded never respawn.
 */
function shouldRespawn({ code, signal, forwardedSignal, sentinel, childPid }) {
  if (forwardedSignal) return false;
  if (code === 0 && !signal) return false;
  return !!(sentinel && sentinel.open === true && sentinel.pid === childPid);
}

/** Crash-loop guard: more than `max` respawns within `windowMs` is refused. */
function checkCrashLoop(timestamps, now, max = MAX_RESPAWNS, windowMs = RESPAWN_WINDOW_MS) {
  const recent = timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= max) return { allow: false, timestamps: recent };
  return { allow: true, timestamps: [...recent, now] };
}

module.exports = {
  logsDir, appendCappedLine, recordExit, rotateIfNeeded, appendStderr, readSentinel,
  shouldRespawn, checkCrashLoop,
  EXIT_LOG, STDERR_LOG, SENTINEL, MAX_EXIT_LINES, MAX_STDERR_BYTES,
  RESPAWN_DELAY_MS, MAX_RESPAWNS, RESPAWN_WINDOW_MS,
};
