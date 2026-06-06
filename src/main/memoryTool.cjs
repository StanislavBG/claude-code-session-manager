/**
 * memoryTool.cjs — Memory tab backend (cycle 3, Bundle C).
 *
 * Workspace-scoped markdown store at Claude's native auto-memory location:
 *   ~/.claude/projects/<workspace>/memory/
 * where <workspace> is a derived encoding of an active cwd (the same
 * transcript-dir slug Claude Code uses). The Memory tab is a list+detail
 * view over these files. Files are plain markdown with optional frontmatter:
 *
 *   ---
 *   name: short label
 *   description: one-line summary
 *   ---
 *   <body>
 *
 * Hard caps:
 *   - 1 MB per file
 *   - 1000 entries per workspace
 *   - slugs MUST match /^[a-z0-9-_]+\.md$/
 *
 * Every read/write/delete is routed through config.cjs's atomic helpers,
 * which in turn pin every absolute path inside the home directory via
 * validatePath (with validateWrite layered on top for mutations).
 */

const { ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const config = require('./config.cjs');

const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
const MAX_ENTRIES = 1000;
const SLUG_RE = /^[a-z0-9-_]+\.md$/;

const { encodeCwd: encodeWorkspace } = require('./lib/encodeCwd.cjs');

function memoryRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function workspaceDir(workspace) {
  // Repointed at Claude's native auto-memory store:
  //   ~/.claude/projects/<encodedCwd>/memory/
  // where <encodedCwd> is the same transcript-dir slug produced by encodeCwd.
  // Reads AND writes target this dir so the user's real memories (incl. the
  // Claude-managed MEMORY.md index) appear in the Memory tab, and new entries
  // land where Claude actually reads them.
  return path.join(memoryRoot(), workspace, 'memory');
}

/**
 * Reject NUL chars, '..' segments, absolute paths, or anything that would
 * resolve outside the workspace dir. Returns the resolved absolute path.
 * The downstream config.cjs helpers add a second layer of validation, but
 * this lets us return a clean error message before we get there.
 */
function resolveEntryPath(workspace, name) {
  if (typeof name !== 'string' || !name) {
    throw new Error('invalid entry name');
  }
  if (name.includes('\0')) throw new Error('NUL in name');
  if (!SLUG_RE.test(name)) {
    throw new Error(`invalid slug (must match ${SLUG_RE.source}): ${name}`);
  }
  const dir = workspaceDir(workspace);
  const full = path.resolve(dir, name);
  // path.resolve normalizes; verify the result is still under dir to guard
  // against bizarre name inputs.
  if (full !== path.join(dir, name)) {
    throw new Error('path escapes workspace');
  }
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path escapes workspace');
  }
  return full;
}

function validWorkspaceName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9-_]{1,256}$/.test(name);
}

async function list({ workspace }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  const dir = workspaceDir(ws);
  const r = await config.listDir(dir, { filesOnly: true });
  if (!r.ok) {
    return { entries: [], workspace: ws, error: r.error };
  }
  const entries = r.entries
    .filter((e) => e.name.endsWith('.md'))
    .map((e) => ({
      name: e.name,
      path: e.path,
      mtimeMs: e.mtimeMs,
      bytes: e.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { entries, workspace: ws, error: null };
}

async function read({ workspace, name }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  const abs = resolveEntryPath(ws, name);
  const r = await config.readText(abs);
  if (!r.exists) {
    return { content: '', exists: false, mtimeMs: 0, bytes: 0, error: r.error };
  }
  return {
    content: r.text,
    exists: true,
    mtimeMs: r.mtimeMs,
    bytes: Buffer.byteLength(r.text, 'utf8'),
    error: null,
  };
}

async function write({ workspace, name, content }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  if (typeof content !== 'string') {
    return { ok: false, error: 'content must be a string' };
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds 1 MiB cap (${bytes} bytes)` };
  }
  const abs = resolveEntryPath(ws, name);
  // Enforce per-workspace entry cap on creates (writes to existing files are
  // always allowed regardless of count). Cheap fs.stat check rather than a
  // full directory enumeration where possible.
  let exists = true;
  try { await fsp.access(abs, fs.constants.F_OK); }
  catch { exists = false; }
  if (!exists) {
    const l = await list({ workspace: ws });
    if (l.entries.length >= MAX_ENTRIES) {
      return { ok: false, error: `workspace at ${MAX_ENTRIES}-entry cap` };
    }
  }
  try {
    await config.writeTextAtomic(abs, content);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteEntry({ workspace, name }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  const abs = resolveEntryPath(ws, name);
  // Route through config.cjs::validatePath (home-boundary pin, symlink-safe)
  // plus validateWrite (write-prefix pin) — same contract every other
  // mutating call in the codebase follows. Complexity: O(1) per call.
  let real;
  try {
    real = config.validatePath(abs);
    config.validateWrite(real);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  try {
    await fsp.unlink(real);
    return { ok: true, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, error: null };
    return { ok: false, error: e.message };
  }
}

async function create({ workspace, name, description }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  const abs = resolveEntryPath(ws, name);
  // Refuse to overwrite — create is strictly "new file".
  try {
    await fsp.access(abs, fs.constants.F_OK);
    return { ok: false, error: 'memory already exists' };
  } catch { /* expected */ }
  const stem = name.replace(/\.md$/, '');
  const desc = typeof description === 'string' ? description.trim() : '';
  const fm = [
    '---',
    `name: ${stem}`,
    ...(desc ? [`description: ${desc.replace(/\n/g, ' ')}`] : []),
    '---',
    '',
    desc || `# ${stem}`,
    '',
  ].join('\n');
  return await write({ workspace: ws, name, content: fm });
}

function registerMemoryHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('memory:list', v(s.memoryList, list));
  ipcMain.handle('memory:read', v(s.memoryRead, read));
  ipcMain.handle('memory:write', v(s.memoryWrite, write));
  ipcMain.handle('memory:delete', v(s.memoryDelete, deleteEntry));
  ipcMain.handle('memory:create', v(s.memoryCreate, create));
}

module.exports = {
  registerMemoryHandlers,
  encodeWorkspace,
  // exported for tests
  memoryRoot,
  workspaceDir,
};
