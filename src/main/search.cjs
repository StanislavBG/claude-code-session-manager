/**
 * Search IPC — fuzzy file path search + content grep.
 *
 * - Prefers ripgrep (`rg`) when present on PATH for both fast file enumeration
 *   (`rg --files`) and content search (`rg --json`). Falls back to a Node
 *   fs-based recursive walk capped at depth 10 when rg is missing.
 * - All cwds are routed through `config.cjs`'s `validatePath` so the renderer
 *   can never search outside the home directory.
 * - 10s wall-clock ceiling per call — search runs that overflow are killed
 *   and return partial results.
 * - Ignored dirs (both modes): .git / node_modules / dist / build / .next /
 *   .cache / coverage / .turbo.
 *
 * Designed to back two renderer modals: QuickOpen (Cmd+P) and GlobalSearch
 * (Cmd+Shift+F).
 */

const { ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { z } = require('zod');

const { validatePath } = require('./config.cjs');

const TIMEOUT_MS = 10_000;
const MAX_FILES = 5000;
const MAX_TEXT_MATCHES = 500;
const MAX_WALK_DEPTH = 10;
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next',
  '.cache', 'coverage', '.turbo', '.parcel-cache', '.pnpm-store',
]);

// ── ripgrep detection ─────────────────────────────────────────────────────
let _rgAvailable = null; // null = unknown, true/false = cached
function probeRipgrep() {
  if (_rgAvailable !== null) return _rgAvailable;
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; _rgAvailable = val; resolve(val); } };
    try {
      const proc = spawn('rg', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('error', () => done(false));
      proc.on('exit', (code) => done(code === 0));
      // Hard timeout: probe shouldn't take more than 1s.
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } done(false); }, 1000);
    } catch {
      done(false);
    }
  });
}

// ── helpers ───────────────────────────────────────────────────────────────
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Spawn rg with argv (no shell), capture stdout/stderr, enforce TIMEOUT_MS.
 * Resolves to { ok, stdout, stderr, exitCode, timedOut }.
 */
function runRg(args, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let proc;
    try {
      proc = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e.message, exitCode: -1, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } }, 500);
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      // Soft cap on buffer growth — if rg yields more than 10 MB of stdout
      // something is wrong with the query; just kill it.
      if (stdout.length > 10 * 1024 * 1024) {
        try { proc.kill('SIGTERM'); } catch { /* noop */ }
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: e.message, exitCode: -1, timedOut });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      // rg exits 1 when zero matches found — that's still "ok" for us.
      resolve({ ok: code === 0 || code === 1, stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

/**
 * Recursive fs walk capped at MAX_WALK_DEPTH and ignoring IGNORED_DIRS.
 * Returns absolute paths. Bails out early at MAX_FILES.
 */
async function fsWalk(rootAbs) {
  const out = [];
  const startedAt = Date.now();
  async function walk(dir, depth) {
    if (depth > MAX_WALK_DEPTH) return;
    if (out.length >= MAX_FILES) return;
    if (Date.now() - startedAt > TIMEOUT_MS) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith('.') && entry.name !== '.env') {
        // Skip dotfiles by default — matches rg's defaults closely enough
        // for our use case. .env is a common exception users may want.
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(rootAbs, 0);
  return out;
}

/**
 * Naive content grep for the rg-fallback path. Reads each file up to 1 MB,
 * splits on newlines, returns the first MAX_TEXT_MATCHES occurrences. Skips
 * binary files heuristically (NUL byte in first 4 KiB).
 */
async function fsGrep(rootAbs, needle, opts) {
  const caseSensitive = !!opts.caseSensitive;
  const limit = Math.max(1, Math.min(MAX_TEXT_MATCHES, opts.limit ?? MAX_TEXT_MATCHES));
  const haystack = caseSensitive ? needle : needle.toLowerCase();
  const startedAt = Date.now();
  const files = await fsWalk(rootAbs);
  const matches = [];
  for (const file of files) {
    if (matches.length >= limit) break;
    if (Date.now() - startedAt > TIMEOUT_MS) break;
    let buf;
    try {
      const st = await fsp.stat(file);
      if (st.size > 1024 * 1024) continue;
      buf = await fsp.readFile(file);
    } catch { continue; }
    // Binary sniff.
    const sniff = buf.slice(0, 4096);
    if (sniff.includes(0)) continue;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= limit) break;
      const line = lines[i];
      const target = caseSensitive ? line : line.toLowerCase();
      const idx = target.indexOf(haystack);
      if (idx !== -1) {
        matches.push({
          path: file,
          line: i + 1,
          column: idx + 1,
          text: line.length > 400 ? line.slice(0, 400) + '…' : line,
        });
      }
    }
  }
  return matches;
}

// ── public API: search:files ──────────────────────────────────────────────
async function searchFiles({ cwd, query, opts }) {
  const limit = Math.max(1, Math.min(MAX_FILES, opts?.limit ?? MAX_FILES));
  let resolved;
  try { resolved = validatePath(expandHome(cwd)); }
  catch (e) { return { ok: false, files: [], error: e.message, usedRipgrep: false }; }

  const usedRipgrep = await probeRipgrep();
  let absPaths = [];
  if (usedRipgrep) {
    // `rg --files` enumerates the tree honoring .gitignore. We add explicit
    // --glob '!dir' exclusions on top in case the repo isn't a git repo.
    const args = [
      '--files', '--hidden', '--follow',
      '--max-filesize', '5M',
    ];
    for (const dir of IGNORED_DIRS) {
      args.push('--glob', `!**/${dir}/**`);
    }
    const result = await runRg(args, resolved);
    if (result.timedOut) {
      return { ok: false, files: [], error: 'search timeout (10s)', usedRipgrep: true };
    }
    if (!result.ok) {
      return { ok: false, files: [], error: result.stderr || `rg exit ${result.exitCode}`, usedRipgrep: true };
    }
    absPaths = result.stdout.split('\n')
      .filter((l) => l.length > 0)
      .map((rel) => path.join(resolved, rel));
  } else {
    absPaths = await fsWalk(resolved);
  }

  // Fuzzy filter / sort happens in renderer. Main returns the candidate set.
  // When query is provided we do a coarse case-insensitive substring filter
  // to cut payload size — renderer's fuzzy ranker handles the precise scoring.
  if (query && query.length > 0) {
    const q = query.toLowerCase();
    absPaths = absPaths.filter((p) => p.toLowerCase().includes(q));
  }
  absPaths = absPaths.slice(0, limit);

  // Shape each entry like files:list so QuickOpen can reuse FileNode types.
  const files = absPaths.map((abs) => ({
    name: path.basename(abs),
    path: abs,
    isDirectory: false,
    isFile: true,
  }));
  return { ok: true, files, error: null, usedRipgrep };
}

// ── public API: search:text ───────────────────────────────────────────────
async function searchText({ cwd, query, opts }) {
  const limit = Math.max(1, Math.min(MAX_TEXT_MATCHES, opts?.limit ?? MAX_TEXT_MATCHES));
  const caseSensitive = !!opts?.caseSensitive;
  if (!query || query.length === 0) {
    return { ok: true, matches: [], error: null, usedRipgrep: false };
  }
  let resolved;
  try { resolved = validatePath(expandHome(cwd)); }
  catch (e) { return { ok: false, matches: [], error: e.message, usedRipgrep: false }; }

  const usedRipgrep = await probeRipgrep();
  if (!usedRipgrep) {
    const matches = await fsGrep(resolved, query, { caseSensitive, limit });
    return { ok: true, matches, error: null, usedRipgrep: false };
  }

  // rg --json gives us { type, data: { ... } } lines. We use --fixed-strings
  // so users don't accidentally trigger regex on `.` or `(`. Renderer can
  // toggle regex later if we ever surface that option.
  const args = [
    '--json', '--fixed-strings', '--hidden', '--follow',
    '--max-filesize', '5M',
    '--max-count', String(limit),
  ];
  if (!caseSensitive) args.push('--ignore-case');
  for (const dir of IGNORED_DIRS) {
    args.push('--glob', `!**/${dir}/**`);
  }
  args.push('--', query);

  const result = await runRg(args, resolved);
  if (result.timedOut) {
    return { ok: false, matches: [], error: 'search timeout (10s)', usedRipgrep: true };
  }
  if (!result.ok) {
    return { ok: false, matches: [], error: result.stderr || `rg exit ${result.exitCode}`, usedRipgrep: true };
  }

  const matches = [];
  const lines = result.stdout.split('\n');
  for (const raw of lines) {
    if (matches.length >= limit) break;
    if (!raw) continue;
    let evt;
    try { evt = JSON.parse(raw); } catch { continue; }
    if (evt.type !== 'match') continue;
    const data = evt.data;
    if (!data) continue;
    const rel = data.path?.text;
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(resolved, rel);
    const lineNum = data.line_number ?? 0;
    let text = data.lines?.text ?? '';
    if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text.length > 400) text = text.slice(0, 400) + '…';
    const column = (data.submatches && data.submatches[0]?.start != null)
      ? data.submatches[0].start + 1
      : 1;
    matches.push({ path: abs, line: lineNum, column, text });
  }
  return { ok: true, matches, error: null, usedRipgrep: true };
}

// ── IPC registration ──────────────────────────────────────────────────────
const searchFilesSchema = z.object({
  cwd: z.string().min(1).max(4096),
  query: z.string().max(1024).optional().default(''),
  opts: z.object({
    limit: z.number().int().min(1).max(MAX_FILES).optional(),
  }).optional(),
});

const searchTextSchema = z.object({
  cwd: z.string().min(1).max(4096),
  query: z.string().min(1).max(1024),
  opts: z.object({
    limit: z.number().int().min(1).max(MAX_TEXT_MATCHES).optional(),
    caseSensitive: z.boolean().optional(),
  }).optional(),
});

function registerSearchHandlers() {
  ipcMain.handle('search:files', (_e, payload) => {
    const parsed = searchFilesSchema.parse(payload);
    return searchFiles(parsed);
  });
  ipcMain.handle('search:text', (_e, payload) => {
    const parsed = searchTextSchema.parse(payload);
    return searchText(parsed);
  });
}

module.exports = {
  registerSearchHandlers,
  // exported for tests
  searchFiles,
  searchText,
  probeRipgrep,
};
