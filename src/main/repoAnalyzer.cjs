/**
 * repo:analyze(cwd) — walk a project tree and return a compact stats snapshot
 * for the RepoVisualizationModal.
 *
 * Ported in spirit from ClaudeCodeUnleashed's src/main/ipc/repoAnalyzer.ts, but
 * stripped down to what we actually surface (no dependency listing, no full
 * tree return, no file-content fetch). The renderer renders:
 *   - language breakdown bar (extension → file count, line count)
 *   - top directories treemap
 *   - uncommitted-file badge from git:status
 * so the IPC return shape stays in lockstep with what the modal needs.
 *
 * Security:
 *   - cwd is validatePath'd (allowedRoots = home). Never follows symlinks
 *     (lstat-based; dirent.isSymbolicLink() check on every entry).
 *   - Hard ceilings: 30s wall-clock, 5000 files, 100KB per-file line counting.
 *   - Reads only — no writes, no spawn.
 *
 * Complexity: O(N) entries where N = files+dirs visited (bounded by
 *   MAX_FILES_TO_ANALYZE). Tail-recursion stack depth is bounded by
 *   MAX_DEPTH (10) so no stack hazards on pathologically nested trees.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { validatePath } = require('./config.cjs');
const { schemas } = require('./ipcSchemas.cjs');
const gitMod = require('./git.cjs');

// Directories to skip — `.git`, common build / dep / cache dirs.
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', '.vscode', '.idea', '__pycache__', 'venv',
  '.env', 'target', 'vendor', 'bower_components',
  '.turbo', '.parcel-cache', '.svelte-kit', '.angular',
]);

// Filenames to skip outright (lockfiles, OS detritus).
const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

// Per-extension display name. Anything not in here lumps under 'other'.
const LANG_LABELS = {
  '.ts': 'TypeScript',
  '.tsx': 'TSX',
  '.js': 'JavaScript',
  '.jsx': 'JSX',
  '.cjs': 'CommonJS',
  '.mjs': 'ES Module',
  '.json': 'JSON',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'Less',
  '.html': 'HTML',
  '.md': 'Markdown',
  '.mdx': 'MDX',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.c': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.h': 'C/C++ Header',
  '.hpp': 'C++ Header',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.xml': 'XML',
  '.svg': 'SVG',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

// Caps. Wall-clock is enforced by an AbortController-style deadline; the
// per-file line cap stops giant generated files (e.g. 5 MB package-lock that
// somehow escapes the ignore list) from blocking the event loop.
const MAX_DEPTH = 12;
const MAX_FILES_TO_ANALYZE = 5000;
const MAX_FILE_SIZE_FOR_LINE_COUNT = 100 * 1024; // 100 KiB
const DEADLINE_MS = 30_000;
const TOP_DIRS_LIMIT = 10;

/** Count newlines without loading entire file into memory beyond the cap. */
async function countLines(filePath, sizeHint) {
  if (sizeHint > MAX_FILE_SIZE_FOR_LINE_COUNT) return 0;
  try {
    const buf = await fsp.readFile(filePath);
    if (buf.length === 0) return 0;
    let n = 1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) n++;
    }
    // Don't count a final empty trailing line.
    if (buf[buf.length - 1] === 0x0a) n--;
    return n;
  } catch {
    return 0;
  }
}

function languageKey(ext) {
  if (!ext) return 'other';
  return LANG_LABELS[ext] ? ext.slice(1) : 'other';
}

/**
 * Recursive walk. Mutates `ctx` (single object per top-level call) so we
 * don't allocate a fresh stats frame per directory — keeps the hot path
 * contiguous (CLAUDE.md performance guidance). Stops early when deadline is
 * past or the file ceiling is hit.
 *
 * Returns the per-immediate-subtree { fileCount, totalLines } so the caller
 * (one level up) can attribute it to the top-level directory bucket.
 */
async function walk(absDir, relDir, depth, ctx) {
  if (ctx.stopped || Date.now() > ctx.deadline) {
    ctx.stopped = true;
    return { fileCount: 0, totalLines: 0 };
  }
  if (depth > MAX_DEPTH) return { fileCount: 0, totalLines: 0 };

  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return { fileCount: 0, totalLines: 0 };
  }

  let subFiles = 0;
  let subLines = 0;

  for (const entry of entries) {
    if (ctx.stopped) break;
    if (Date.now() > ctx.deadline) {
      ctx.stopped = true;
      break;
    }

    // Never follow symlinks (security). withFileTypes gives us
    // isSymbolicLink() directly — no extra stat needed.
    if (entry.isSymbolicLink()) continue;

    const name = entry.name;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      const childAbs = path.join(absDir, name);
      const childRel = relDir ? path.join(relDir, name) : name;
      const result = await walk(childAbs, childRel, depth + 1, ctx);
      subFiles += result.fileCount;
      subLines += result.totalLines;
      continue;
    }

    if (!entry.isFile()) continue;
    if (IGNORE_FILES.has(name)) continue;
    if (ctx.fileCount >= MAX_FILES_TO_ANALYZE) {
      ctx.stopped = true;
      break;
    }

    ctx.fileCount++;
    subFiles++;
    ctx.totalFiles++;

    const ext = path.extname(name).toLowerCase();
    let size = 0;
    let lines = 0;
    try {
      const st = await fsp.stat(path.join(absDir, name));
      size = st.size;
    } catch {
      // unreadable — count the file but skip lines
    }

    // Only line-count "interesting" files. JSON / SVG / XML / YAML are noisy
    // and don't really represent "code"; skipping them keeps the LOC number
    // closer to what a developer expects.
    if (LANG_LABELS[ext] && ext !== '.svg' && ext !== '.xml' && ext !== '.json') {
      lines = await countLines(path.join(absDir, name), size);
    }
    subLines += lines;
    ctx.totalLines += lines;

    // Language breakdown bucket.
    const key = languageKey(ext);
    const langBucket = ctx.languages[key] ?? (ctx.languages[key] = { files: 0, lines: 0 });
    langBucket.files++;
    langBucket.lines += lines;
  }

  // Top-dir attribution happens in analyze() based on the return value, not
  // here — avoids double-pushing when walk recurses into nested dirs.
  return { fileCount: subFiles, totalLines: subLines };
}

/**
 * repo:analyze entry — runs the walk, then asks git.cjs for status (cached,
 * so this is cheap when called repeatedly). On any path-validation or fs
 * failure returns a `{ ok:false, error }` shape so the renderer can decide
 * whether to show an error state or just empty stats.
 */
async function analyze(cwd) {
  let realCwd;
  try {
    realCwd = validatePath(cwd);
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'invalid cwd' };
  }

  const startMs = Date.now();
  const ctx = {
    deadline: startMs + DEADLINE_MS,
    stopped: false,
    fileCount: 0,
    totalFiles: 0,
    totalLines: 0,
    languages: Object.create(null),
    topDirs: [],
  };

  // Walk the top-level dir manually (we want depth-1 directories listed in
  // topDirs but not "." itself).
  let entries;
  try {
    entries = await fsp.readdir(realCwd, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'readdir failed' };
  }

  // First pass: count files directly in the root, group root-level loose
  // files under a synthetic "(root)" bucket so they're visible in the treemap.
  let rootLooseFiles = 0;
  let rootLooseLines = 0;

  // Process directories at depth 1, files at depth 0 (root). We follow the
  // pattern: lstat-equivalent (entry.isSymbolicLink()) → no follow.
  for (const entry of entries) {
    if (ctx.stopped) break;
    if (Date.now() > ctx.deadline) { ctx.stopped = true; break; }
    if (entry.isSymbolicLink()) continue;
    const name = entry.name;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      const result = await walk(path.join(realCwd, name), name, 1, ctx);
      ctx.topDirs.push({ path: name, fileCount: result.fileCount, totalLines: result.totalLines });
      continue;
    }

    if (!entry.isFile()) continue;
    if (IGNORE_FILES.has(name)) continue;
    if (ctx.fileCount >= MAX_FILES_TO_ANALYZE) { ctx.stopped = true; break; }

    ctx.fileCount++;
    ctx.totalFiles++;
    rootLooseFiles++;

    const ext = path.extname(name).toLowerCase();
    let size = 0;
    let lines = 0;
    try {
      const st = await fsp.stat(path.join(realCwd, name));
      size = st.size;
    } catch { /* */ }
    if (LANG_LABELS[ext] && ext !== '.svg' && ext !== '.xml' && ext !== '.json') {
      lines = await countLines(path.join(realCwd, name), size);
    }
    rootLooseLines += lines;
    ctx.totalLines += lines;
    const key = languageKey(ext);
    const langBucket = ctx.languages[key] ?? (ctx.languages[key] = { files: 0, lines: 0 });
    langBucket.files++;
    langBucket.lines += lines;
  }

  if (rootLooseFiles > 0) {
    ctx.topDirs.push({ path: '(root)', fileCount: rootLooseFiles, totalLines: rootLooseLines });
  }

  // Sort top dirs by file count desc, then trim. Tie-break by name for stability.
  ctx.topDirs.sort((a, b) => {
    if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
    return a.path.localeCompare(b.path);
  });
  const topDirectories = ctx.topDirs.slice(0, TOP_DIRS_LIMIT);

  // Materialize the languages map sorted by file count desc.
  const languageBreakdown = Object.create(null);
  const langEntries = Object.entries(ctx.languages).sort((a, b) => b[1].files - a[1].files);
  for (const [k, v] of langEntries) languageBreakdown[k] = v;

  // Git status — best-effort. Failure (not a git repo / git missing / timeout)
  // returns null which we surface as { uncommitted: 0, branch: null }.
  let gitStatus = { uncommitted: 0, branch: null };
  try {
    const s = await gitMod.getStatus(realCwd);
    if (s) {
      gitStatus = {
        uncommitted: s.uncommittedCount || 0,
        branch: s.branch || null,
      };
    }
  } catch { /* gitMod swallows errors but be defensive */ }

  return {
    ok: true,
    cwd: realCwd,
    totalFiles: ctx.totalFiles,
    totalLines: ctx.totalLines,
    languageBreakdown,
    topDirectories,
    gitStatus,
    truncated: ctx.stopped,
    durationMs: Date.now() - startMs,
  };
}

function register(ipcMain) {
  ipcMain.handle('repo:analyze', async (_e, payload) => {
    const parsed = schemas.repoAnalyze.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: 'invalid payload' };
    }
    return analyze(parsed.data.cwd);
  });
}

module.exports = {
  register,
  analyze,
  // Exported for tests.
  LANG_LABELS,
  IGNORE_DIRS,
};
