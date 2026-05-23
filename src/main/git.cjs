/**
 * Git IPC handlers — richer status data than the StatusBar-only `app:git-branch`.
 *
 * Ported (in spirit) from ClaudeCodeUnleashed's src/main/ipc/git.ts. Built
 * fresh for our conventions: argv-array spawn (never shell:true), validatePath
 * gating, zod-validated IPC payloads, 5s timeout ceiling, 5s per-cwd cache.
 *
 * Channels:
 *   git:status      → { branch, ahead, behind, uncommittedCount, files[] } | null
 *   git:file-status → { [absolutePath]: 'modified' | 'added' | 'deleted' |
 *                       'renamed' | 'untracked' | 'staged' | 'conflict' }
 *
 * "Not a git repo" / spawn errors / timeouts all surface as `null` (status)
 * or `{}` (file-status) so the renderer can render unconditionally.
 *
 * Future readers: this file is for OBSERVATION only. No mutation commands
 * (commit/push/pull/add) — those belong to a separate, much-more-restricted
 * surface if they ever land. The whole point of the cache is so the planned
 * file-tree sidebar can poll cheaply without spawning git for every render.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { schemas } = require('./ipcSchemas.cjs');
const { validatePath } = require('./config.cjs');

const GIT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MiB — same cap Unleashed uses

// Per-cwd in-memory caches. Keyed by the realpath-validated cwd so symlinks
// to the same repo dedupe. Each entry: { value, expiresAt }.
const statusCache = new Map();
const fileStatusCache = new Map();

/**
 * Run `git <args>` in cwd with a hard 5s SIGKILL ceiling. Resolves
 * { ok:true, stdout } on exit 0, { ok:false, code, stderr } otherwise.
 * Never throws — IPC handlers want a discriminated result, not an exception.
 *
 * argv-array spawn — never `shell: true`. cwd MUST already be validatePath-checked.
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('git', args, {
        cwd,
        windowsHide: true,
        // Inherit env minus anything that could change git behaviour; default
        // is fine here — we explicitly do NOT want `cleanChildEnv` because
        // git relies on $HOME/$PATH/$GIT_* to find config + ssh credentials.
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stderr: `spawn failed: ${err?.message ?? String(err)}` });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, GIT_TIMEOUT_MS);

    proc.stdout.on('data', (b) => {
      if (stdoutLen < MAX_BUFFER) {
        stdoutChunks.push(b);
        stdoutLen += b.length;
      }
    });
    proc.stderr.on('data', (b) => {
      if (stderrLen < MAX_BUFFER) {
        stderrChunks.push(b);
        stderrLen += b.length;
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ ok: false, code: -1, stderr: `spawn error: ${err?.message ?? String(err)}` });
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        resolve({ ok: false, code: -1, stderr: `timeout after ${GIT_TIMEOUT_MS}ms\n${stderr}` });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else {
        resolve({ ok: false, code: typeof code === 'number' ? code : -1, stderr });
      }
    });
  });
}

/**
 * Unquote a git path. With porcelain v1 *without* -z, git quotes paths
 * containing special chars (spaces, unicode, control bytes). We use -z so
 * paths come through raw NUL-separated, but kept as a defensive shim in
 * case a future caller drops -z.
 */
function unquoteGitPath(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return p;
}

/**
 * Map porcelain XY pair to one of our enum values. Mirrors Unleashed's
 * git-file-status handler, with the same conflict-detection rules.
 *
 *   ' M' → modified           '??' → untracked
 *   'A ' → added              'AM' → added (index) — staged-then-modified
 *   ' D' → deleted            'D ' → deleted
 *   'R ' → renamed            'C ' → added (copy treated as new)
 *   'U.' / '.U' / 'DD' / 'AA' → conflict
 *   any other staged change   → staged
 */
function mapStatus(indexChar, workChar) {
  if (indexChar === '?' && workChar === '?') return 'untracked';
  if (
    indexChar === 'U' || workChar === 'U' ||
    (indexChar === 'D' && workChar === 'D') ||
    (indexChar === 'A' && workChar === 'A')
  ) return 'conflict';
  if (indexChar === 'A') return 'added';
  if (indexChar === 'D' || workChar === 'D') return 'deleted';
  if (indexChar === 'R') return 'renamed';
  if (indexChar === 'C') return 'added';
  if (indexChar !== ' ' && indexChar !== '?') return 'staged';
  if (workChar === 'M') return 'modified';
  return 'modified';
}

/**
 * Parse `git status --porcelain=v1 -b -u -z` output.
 *
 * First entry (when -b is set) is the branch header:
 *   "## main...origin/main [ahead 1, behind 2]"
 *   "## HEAD (no branch)" — detached
 *   "## No commits yet on main"
 *
 * Remaining entries are NUL-separated "XY <path>" records. Renamed/copied
 * records consume TWO entries (new path, then original path).
 *
 * Returns { branch, ahead, behind, files }.
 */
function parsePorcelain(stdout, cwd) {
  const entries = stdout.split('\0').filter((e) => e.length > 0);
  const out = {
    branch: 'HEAD',
    ahead: 0,
    behind: 0,
    files: [],
  };

  let i = 0;
  // Branch header
  if (entries.length > 0 && entries[0].startsWith('## ')) {
    const header = entries[0].slice(3);
    if (header.startsWith('No commits yet on ')) {
      out.branch = header.slice('No commits yet on '.length).split(' ')[0];
    } else if (header.startsWith('HEAD (no branch)')) {
      out.branch = 'HEAD';
    } else {
      // "main" or "main...origin/main [ahead 1, behind 2]"
      const m = /^([^.\s]+)(?:\.\.\.([^\s]+))?(?:\s+\[([^\]]+)\])?/.exec(header);
      if (m) {
        out.branch = m[1];
        const bracket = m[3];
        if (bracket) {
          const am = /ahead (\d+)/.exec(bracket);
          const bm = /behind (\d+)/.exec(bracket);
          if (am) out.ahead = parseInt(am[1], 10) || 0;
          if (bm) out.behind = parseInt(bm[1], 10) || 0;
        }
      }
    }
    i = 1;
  }

  while (i < entries.length) {
    const entry = entries[i];
    if (entry.length < 3) { i++; continue; }
    const indexChar = entry[0];
    const workChar = entry[1];
    // Format with -z: "XY <path>" — note SINGLE space between XY and path.
    let filePath = entry.substring(3);

    // Renamed/copied → next entry is the original path; skip it.
    if (indexChar === 'R' || indexChar === 'C') {
      i++;
    }

    filePath = unquoteGitPath(filePath);
    const absolutePath = path.resolve(cwd, filePath);
    const status = mapStatus(indexChar, workChar);

    out.files.push({
      path: absolutePath,
      relativePath: filePath,
      status,
      indexStatus: indexChar,
      workTreeStatus: workChar,
    });

    i++;
  }

  return out;
}

/**
 * git:status(cwd) — full status. Returns null if not a git repo / git fails.
 *
 * Cached per realpath-cwd for 5s so the renderer can poll cheaply (the
 * planned file-tree sidebar will tick this every couple seconds).
 */
async function getStatus(cwd) {
  let realCwd;
  try {
    realCwd = validatePath(cwd);
  } catch {
    return null;
  }

  const now = Date.now();
  const cached = statusCache.get(realCwd);
  if (cached && cached.expiresAt > now) return cached.value;

  // Single porcelain call gets us branch + ahead/behind + files in one shot.
  const result = await runGit(
    ['status', '--porcelain=v1', '-b', '-u', '-z'],
    realCwd,
  );

  if (!result.ok) {
    // "not a git repository" or any other failure → null
    statusCache.set(realCwd, { value: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const parsed = parsePorcelain(result.stdout, realCwd);
  const value = {
    branch: parsed.branch,
    ahead: parsed.ahead,
    behind: parsed.behind,
    uncommittedCount: parsed.files.length,
    files: parsed.files,
  };
  statusCache.set(realCwd, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * git:file-status(cwd) — `{ absPath: status }` map. Returns `{}` if not a
 * git repo / git fails. Same 5s per-cwd cache.
 */
async function getFileStatus(cwd) {
  let realCwd;
  try {
    realCwd = validatePath(cwd);
  } catch {
    return {};
  }

  const now = Date.now();
  const cached = fileStatusCache.get(realCwd);
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await runGit(
    ['status', '--porcelain=v1', '-u', '-z'],
    realCwd,
  );

  if (!result.ok) {
    fileStatusCache.set(realCwd, { value: {}, expiresAt: now + CACHE_TTL_MS });
    return {};
  }

  // No -b here, so parsePorcelain's branch-header branch will simply not fire.
  const parsed = parsePorcelain(result.stdout, realCwd);
  const map = {};
  for (const f of parsed.files) {
    map[f.path] = f.status;
  }
  fileStatusCache.set(realCwd, { value: map, expiresAt: now + CACHE_TTL_MS });
  return map;
}

/** Drop cached entries — useful for tests / forced refresh. Not wired to IPC. */
function clearCache() {
  statusCache.clear();
  fileStatusCache.clear();
}

function register(ipcMain) {
  ipcMain.handle('git:status', async (_e, payload) => {
    const parsed = schemas.gitStatus.safeParse(payload);
    if (!parsed.success) return null;
    return getStatus(parsed.data.cwd);
  });

  ipcMain.handle('git:file-status', async (_e, payload) => {
    const parsed = schemas.gitFileStatus.safeParse(payload);
    if (!parsed.success) return {};
    return getFileStatus(parsed.data.cwd);
  });
}

module.exports = {
  register,
  // Exposed for unit-test / sanity-check use.
  getStatus,
  getFileStatus,
  parsePorcelain,
  mapStatus,
  clearCache,
};
