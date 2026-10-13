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

const { MEMORY_SLUG_RE: SLUG_RE } = require('./lib/memorySlug.cjs');
const { scoreMemories } = require('./lib/memoryStale.cjs');
const { addIndexLine, removeIndexLines, indexHealth } = require('./lib/memoryIndex.cjs');
const {
  resolveWorkspaceMemoryDir,
  autoMemoryEnabled,
  resolveAgentMemoryDir,
  listMemoryAgents,
  gitRepoRoot,
} = require('./lib/memoryDirResolve.cjs');

const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
const MAX_ENTRIES = 1000;

const { encodeCwd: encodeWorkspace } = require('./lib/util/encodeCwd.cjs');

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

/** Read + parse a settings file; missing/malformed -> null. */
async function readSettings(abs) {
  try {
    const r = await config.readText(abs);
    if (!r.exists) return null;
    const parsed = JSON.parse(r.text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The one place a memory directory is chosen.
 *   agent -> native subagent memory dir (root = git root of cwd, or cwd)
 *   cwd   -> Claude Code's native workspace dir (git root + autoMemoryDirectory)
 *   else  -> legacy ~/.claude/projects/<workspace>/memory
 * Returns { dir, autoMemoryEnabled }. Throws on an invalid cwd/agent; every path
 * the callers derive from `dir` still goes through config.validatePath/validateWrite.
 */
async function resolveDir({ workspace, cwd, agent } = {}) {
  const home = os.homedir();
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  if (typeof cwd !== 'string' || !cwd) {
    if (agent) throw new Error('agent memory requires a cwd');
    return { dir: workspaceDir(ws), autoMemoryEnabled: true };
  }
  const realCwd = config.validatePath(cwd);
  const root = gitRepoRoot(realCwd, require('node:child_process').execFileSync) || realCwd;
  const realRoot = config.validatePath(root);
  // Project-scoped native dirs live under <root>/.claude; validateWrite only
  // permits that subtree for registered roots.
  config.addAllowedRoot(realRoot);
  const settings = {
    user: await readSettings(path.join(home, '.claude', 'settings.json')),
    project: await readSettings(path.join(realRoot, '.claude', 'settings.json')),
    local: await readSettings(path.join(realRoot, '.claude', 'settings.local.json')),
  };
  const enabled = autoMemoryEnabled(settings);
  if (agent) {
    return { dir: resolveAgentMemoryDir({ home, root: realRoot, name: agent.name, scope: agent.scope }), autoMemoryEnabled: enabled };
  }
  const r = resolveWorkspaceMemoryDir({ home, cwd: realCwd, settings, repoRoot: realRoot });
  return { dir: r.dir, autoMemoryEnabled: enabled };
}

/**
 * Reject NUL chars, '..' segments, absolute paths, or anything that would
 * resolve outside the workspace dir. Returns the resolved absolute path.
 * The downstream config.cjs helpers add a second layer of validation, but
 * this lets us return a clean error message before we get there.
 */
function resolveEntryPath(dir, name) {
  if (typeof name !== 'string' || !name) {
    throw new Error('invalid entry name');
  }
  if (name.includes('\0')) throw new Error('NUL in name');
  if (!SLUG_RE.test(name)) {
    throw new Error(`invalid slug (must match ${SLUG_RE.source}): ${name}`);
  }
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

async function list({ workspace, cwd, agent }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  let resolved;
  try { resolved = await resolveDir({ workspace: ws, cwd, agent }); }
  catch (e) { return { entries: [], workspace: ws, dir: null, autoMemoryEnabled: true, error: e.message }; }
  const { dir } = resolved;
  const r = await config.listDir(dir, { filesOnly: true });
  if (!r.ok) {
    return { entries: [], workspace: ws, dir, autoMemoryEnabled: resolved.autoMemoryEnabled, error: r.error };
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
  return { entries, workspace: ws, dir, autoMemoryEnabled: resolved.autoMemoryEnabled, error: null };
}

async function read({ workspace, name, cwd, agent }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  let abs;
  try { abs = resolveEntryPath((await resolveDir({ workspace: ws, cwd, agent })).dir, name); }
  catch (e) { return { content: '', exists: false, mtimeMs: 0, bytes: 0, error: e.message }; }
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

async function write({ workspace, name, content, cwd, agent }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  if (typeof content !== 'string') {
    return { ok: false, error: 'content must be a string' };
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds 1 MiB cap (${bytes} bytes)` };
  }
  let abs;
  try { abs = resolveEntryPath((await resolveDir({ workspace: ws, cwd, agent })).dir, name); }
  catch (e) { return { ok: false, error: e.message }; }
  // Enforce per-workspace entry cap on creates (writes to existing files are
  // always allowed regardless of count). Cheap fs.stat check rather than a
  // full directory enumeration where possible.
  let exists = true;
  try { await fsp.access(abs, fs.constants.F_OK); }
  catch { exists = false; }
  if (!exists) {
    const l = await list({ workspace: ws, cwd, agent });
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

const INDEX_NAME = 'MEMORY.md';

/** Read <dir>/MEMORY.md; missing/unreadable -> null. */
async function readIndexText(dir) {
  const r = await config.readText(path.join(dir, INDEX_NAME));
  return r.exists ? r.text : null;
}

async function deleteEntry({ workspace, name, cwd, agent }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  let abs;
  let dir;
  try {
    dir = (await resolveDir({ workspace: ws, cwd, agent })).dir;
    abs = resolveEntryPath(dir, name);
  } catch (e) { return { ok: false, error: e.message }; }
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
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: e.message };
  }
  if (name === INDEX_NAME) return { ok: true, error: null };
  try {
    const text = await readIndexText(dir);
    if (text !== null) {
      const next = removeIndexLines(text, name);
      if (next !== text) await config.writeTextAtomic(path.join(dir, INDEX_NAME), next);
    }
  } catch (e) {
    return { ok: true, error: null, indexError: e.message };
  }
  return { ok: true, error: null };
}

async function create({ workspace, name, description, cwd, agent }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  let abs;
  let dir;
  try {
    dir = (await resolveDir({ workspace: ws, cwd, agent })).dir;
    abs = resolveEntryPath(dir, name);
  } catch (e) { return { ok: false, error: e.message }; }
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
  const w = await write({ workspace: ws, name, content: fm, cwd, agent });
  if (!w.ok || name === INDEX_NAME) return w;
  try {
    const text = (await readIndexText(dir)) || '';
    const next = addIndexLine(text, { file: name, title: stem, hook: desc.replace(/\n/g, ' ') });
    if (next !== text) await config.writeTextAtomic(path.join(dir, INDEX_NAME), next);
  } catch (e) {
    return { ...w, indexError: e.message };
  }
  return w;
}

/**
 * Deterministic, zero-LLM-cost staleness report for a workspace's memories.
 * `cwd`, when supplied, is validated through config.validatePath (same
 * home-boundary contract as every other path in this file) and used only for
 * the dead-ref existence check. Absent/invalid cwd disables dead-ref
 * detection entirely rather than mass-flagging memories.
 */
async function stale({ workspace, cwd, agent }) {
  const ws = validWorkspaceName(workspace) ? workspace : 'default';
  let dir;
  try { dir = (await resolveDir({ workspace: ws, cwd, agent })).dir; }
  catch (e) { return { entries: [], workspace: ws, error: e.message }; }
  const r = await config.listDir(dir, { filesOnly: true });
  if (!r.ok) {
    return { entries: [], workspace: ws, error: r.error };
  }
  const names = r.entries.map((e) => e.name).filter((n) => SLUG_RE.test(n)).sort();

  let baseDir = null;
  if (typeof cwd === 'string' && cwd) {
    try {
      const validated = config.validatePath(cwd);
      if (fs.existsSync(validated) && fs.statSync(validated).isDirectory()) {
        baseDir = validated;
      }
    } catch {
      baseDir = null;
    }
  }
  const existsPath = baseDir
    ? (relPath) => {
        const full = path.resolve(baseDir, relPath);
        if (full !== baseDir && !full.startsWith(baseDir + path.sep)) return false;
        return fs.existsSync(full);
      }
    : () => true;

  const entries = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    const r2 = await config.readText(abs);
    if (!r2.exists) continue;
    entries.push({ name, mtimeMs: r2.mtimeMs, body: r2.text });
  }

  const index = indexHealth({ indexText: await readIndexText(dir), files: r.entries.map((e) => e.name).filter((n) => n.endsWith('.md')) });
  return { entries: scoreMemories({ entries, now: Date.now(), existsPath }), workspace: ws, error: null, index };
}

/** Agents (user + project) with their `memory:` frontmatter scope. */
async function agents({ cwd } = {}) {
  const home = os.homedir();
  let root = null;
  if (typeof cwd === 'string' && cwd) {
    try {
      const realCwd = config.validatePath(cwd);
      root = config.validatePath(gitRepoRoot(realCwd, require('node:child_process').execFileSync) || realCwd);
    } catch {
      root = null;
    }
  }
  return {
    agents: listMemoryAgents({
      home,
      root,
      readDir: (d) => fs.readdirSync(d),
      readText: (f) => fs.readFileSync(f, 'utf8'),
    }),
  };
}

// memory:verify/archive/restore/listArchived/ask/proposeFix — thin delegates to
// lib/memoryOps.cjs and memoryAssist.cjs; folder choice stays in resolveDir.
async function memoryOp(fn, payload, failure) {
  let dir;
  try { dir = (await resolveDir(payload)).dir; }
  catch (e) { return { ...failure, error: e.message }; }
  return fn(dir);
}

const verifyEntry = ({ name, ...t }) => memoryOp((dir) => require('./lib/memoryOps.cjs').verify(dir, name), t, { ok: false });
const archiveEntry = ({ name, ...t }) => memoryOp((dir) => require('./lib/memoryOps.cjs').archive(dir, name), t, { ok: false });
const restoreEntry = ({ name, ...t }) => memoryOp((dir) => require('./lib/memoryOps.cjs').restore(dir, name), t, { ok: false });
const listArchivedEntries = (t) => memoryOp((dir) => require('./lib/memoryOps.cjs').listArchived(dir), t, { names: [] });
const askMemory = ({ question, contextName, ...t }) =>
  memoryOp((dir) => require('./memoryAssist.cjs').ask({ question, dir, contextName }), t, { ok: false, answer: '', citations: [] });

async function proposeFix({ name, ...t }) {
  const fail = (error) => ({ ok: false, content: '', summary: '', error });
  let dir;
  let cwd;
  try {
    if (typeof t.cwd !== 'string' || !t.cwd) return fail('proposeFix requires a cwd');
    cwd = config.validatePath(t.cwd);
    dir = (await resolveDir(t)).dir;
  } catch (e) { return fail(e.message); }
  return require('./memoryAssist.cjs').proposeFix({ name, dir, cwd });
}

function registerMemoryHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('memory:list', v(s.memoryList, list));
  ipcMain.handle('memory:read', v(s.memoryRead, read));
  ipcMain.handle('memory:write', v(s.memoryWrite, write));
  ipcMain.handle('memory:delete', v(s.memoryDelete, deleteEntry));
  ipcMain.handle('memory:create', v(s.memoryCreate, create));
  ipcMain.handle('memory:stale', v(s.memoryStale, stale));
  ipcMain.handle('memory:agents', v(s.memoryAgents, agents));
  ipcMain.handle('memory:verify', v(s.memoryVerify, verifyEntry));
  ipcMain.handle('memory:archive', v(s.memoryArchive, archiveEntry));
  ipcMain.handle('memory:restore', v(s.memoryRestore, restoreEntry));
  ipcMain.handle('memory:listArchived', v(s.memoryListArchived, listArchivedEntries));
  ipcMain.handle('memory:ask', v(s.memoryAsk, askMemory));
  ipcMain.handle('memory:proposeFix', v(s.memoryProposeFix, proposeFix));
}

module.exports = {
  registerMemoryHandlers,
  encodeWorkspace,
  // exported for tests
  memoryRoot,
  workspaceDir,
  resolveDir,
  list,
  read,
  write,
  create,
  deleteEntry,
  agents,
  stale,
};
