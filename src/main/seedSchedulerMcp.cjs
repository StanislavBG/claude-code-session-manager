/**
 * First-boot seeder for the `session-manager-scheduler` MCP server at USER
 * scope (`~/.claude.json`).
 *
 * Why user scope: the scheduler MCP server is a machine-wide service (it
 * talks to the session-manager Electron app's loopback admin API, not
 * anything project-specific). Registering it per-project in each repo's own
 * .mcp.json is the wrong shape — a project whose .mcp.json omits it silently
 * loses access to `scheduler_create_prd` with no error, so agents fall back
 * to hand-writing PRDs or implementing inline instead of queueing. See
 * `scripts/install-scheduler-mcp-user-scope.sh` (the manual installer this
 * seeder promotes to automatic) for the full incident history.
 *
 * Idempotent two ways, mirroring `seedDevPlugin.cjs`:
 *
 *   1. A marker file (`~/.claude/session-manager/.scheduler-mcp-seeded`)
 *      records seed state. Once registration SUCCEEDS we write `done` and
 *      never touch it again, so a deliberate `claude mcp remove` stays
 *      removed. A FAILED attempt only bumps an attempt counter and retries
 *      on the next few boots (e.g. `claude` not yet on PATH). After
 *      MAX_ATTEMPTS we give up (the manual installer script is always
 *      available as a fallback).
 *   2. Before attempting, we check `~/.claude.json`'s `mcpServers` — if
 *      `session-manager-scheduler` is already registered at user scope
 *      (e.g. via the manual installer), we just write the marker and skip.
 *
 * Never overwrites or removes an existing user-scope registration, and never
 * touches any other MCP server entry.
 *
 * Fire-and-forget: called post-window from index.cjs. Errors are logged,
 * never thrown. Kill-switch: SM_SEED_SCHEDULER_MCP_DISABLE=1.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const { writeJsonSync } = require('./config.cjs');

const SERVER_NAME = 'session-manager-scheduler';
const MAX_ATTEMPTS = 3; // give a transient first-boot failure a few chances

function markerPath() {
  return path.join(os.homedir(), '.claude', 'session-manager', '.scheduler-mcp-seeded');
}

/** Absolute path to the bundled scheduler MCP server, resolved from
 *  __dirname (never process.cwd() / never repo-relative). src/main/ -> ../.. */
function serverScriptPath() {
  return path.join(__dirname, '..', '..', 'scripts', 'scheduler-mcp-server.cjs');
}

/** Read the marker -> { done:boolean, attempts:number }. Absent = fresh. */
function readMarker() {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf8').trim();
    const m = JSON.parse(raw);
    return { done: !!m.done, attempts: Number(m.attempts) || 0 };
  } catch {
    return { done: false, attempts: 0 };
  }
}

function writeMarker(state) {
  try {
    writeJsonSync(markerPath(), { ...state, ts: new Date().toISOString() });
  } catch (err) {
    console.warn('[seedSchedulerMcp] could not write marker:', err?.message ?? err);
  }
}

function alreadyRegistered() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    const servers = JSON.parse(raw)?.mcpServers;
    return !!(servers && servers[SERVER_NAME]);
  } catch {
    return false; // ~/.claude.json absent/unparseable — treat as not-registered.
  }
}

/** Run `claude mcp add session-manager-scheduler --scope user -- node <serverPath>`.
 *  No shell:true — argv array passed directly to spawn. */
function runClaudeMcpAdd(serverPath) {
  return new Promise((resolve) => {
    const claudeBin = resolveClaudeBin();
    let proc;
    try {
      proc = spawn(
        claudeBin,
        ['mcp', 'add', SERVER_NAME, '--scope', 'user', '--', 'node', serverPath],
        {
          cwd: os.homedir(),
          env: cleanChildEnv({ PATH: pathWithUserBins() }),
          stdio: 'ignore',
        }
      );
    } catch (err) {
      resolve({ ok: false, error: err?.message ?? String(err) });
      return;
    }
    proc.on('error', (err) => resolve({ ok: false, error: err?.message ?? String(err) }));
    proc.on('close', (code) => resolve({ ok: code === 0, exitCode: code }));
  });
}

async function seedSchedulerMcp({ logger = console, addFn = runClaudeMcpAdd, writeLog = () => {} } = {}) {
  if (process.env.SM_SEED_SCHEDULER_MCP_DISABLE === '1') return;
  const marker = readMarker();
  if (marker.done) return;                       // succeeded before — leave it alone.
  if (marker.attempts >= MAX_ATTEMPTS) return;   // gave up — manual install only.

  try {
    if (alreadyRegistered()) {
      writeMarker({ done: true, attempts: marker.attempts });
      return;
    }
    logger.log?.('[seedSchedulerMcp] registering session-manager-scheduler at user scope…');
    const r = await addFn(serverScriptPath());
    if (r.ok) {
      logger.log?.('[seedSchedulerMcp] registered session-manager-scheduler at user scope');
      writeMarker({ done: true, attempts: marker.attempts });
    } else {
      // Failure: bump the attempt counter so the next boot can retry (bounded).
      logger.warn?.(`[seedSchedulerMcp] registration failed${r.error ? ` — ${r.error}` : ''}; attempt ${marker.attempts + 1}/${MAX_ATTEMPTS}`);
      writeLog({
        scope: 'seed-scheduler-mcp',
        level: 'error',
        message: 'registration failed',
        meta: { error: r.error, exitCode: r.exitCode, attempt: marker.attempts + 1, maxAttempts: MAX_ATTEMPTS },
      });
      writeMarker({ done: false, attempts: marker.attempts + 1 });
    }
  } catch (err) {
    logger.warn?.('[seedSchedulerMcp] error:', err?.message ?? err);
    writeLog({
      scope: 'seed-scheduler-mcp',
      level: 'error',
      message: 'seed error',
      meta: { error: err?.message ?? String(err), attempt: marker.attempts + 1, maxAttempts: MAX_ATTEMPTS },
    });
    writeMarker({ done: false, attempts: marker.attempts + 1 });
  }
}

module.exports = { seedSchedulerMcp, markerPath, MAX_ATTEMPTS, serverScriptPath, SERVER_NAME };
