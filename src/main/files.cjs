/**
 * Files IPC — file-tree-sidebar backend.
 *
 * Mirrors Unleashed's files IPC but routes every path through config.cjs's
 * `validatePath` (allowedRoots = home dir), and uses `shell.trashItem` for
 * delete so renames/deletes are recoverable from the OS trash.
 *
 * Notes:
 *   - Reads are constrained to anywhere inside the home dir.
 *   - Writes (create/rename/delete) likewise stay inside home but additionally
 *     reject anything that would land on `.credentials.json`.
 *   - All listings sort directories first, then alphabetically.
 *   - The renderer is expected to pass absolute paths only. Tilde is expanded.
 */

const { ipcMain, shell } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { z } = require('zod');
const { assertInsideHome } = require('./lib/insideHome.cjs');
const { expandHome } = require('./lib/expandHome.cjs');

/**
 * Validates that the path is under the home directory. Returns the realpath
 * or throws. Files IPC is intentionally home-scoped — broader than
 * config.cjs's write boundaries, since the user may browse any project under
 * ~ — but never escapes the home tree.
 */
function validateHomePath(abs) {
  return assertInsideHome(expandHome(abs)).realPath;
}

/** Reject .credentials.json writes regardless of where they sit. */
function rejectCredentials(real) {
  if (path.basename(real) === '.credentials.json') {
    throw new Error('Write to .credentials.json denied');
  }
}

// Invalid characters for file/folder names (cross-platform).
const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validateName(name) {
  if (!name || name.trim().length === 0) return 'Name cannot be empty';
  if (name !== name.trim()) return 'Name cannot start or end with whitespace';
  if (name === '.' || name === '..') return 'Name cannot be "." or ".."';
  if (INVALID_NAME_CHARS.test(name)) return 'Name contains invalid characters';
  if (RESERVED_NAMES.test(name.split('.')[0])) return 'Name is a reserved system name';
  if (name.length > 255) return 'Name is too long (max 255 characters)';
  return null;
}

async function listDir(dirPath, showHidden) {
  let resolved;
  try { resolved = validateHomePath(dirPath); }
  catch (e) { return { ok: false, entries: [], error: e.message }; }

  try {
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) continue;
      const full = path.join(resolved, entry.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await fsp.stat(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch { /* skip unreadable */ continue; }
      out.push({
        name: entry.name,
        path: full,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size,
        mtimeMs,
      });
    }
    out.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries: out, error: null };
  } catch (e) {
    return { ok: false, entries: [], error: e.message };
  }
}

// Extension → MIME used for the binary-file fallback summary. Mirrors the
// SMFILE_MIME table in index.cjs; kept here so readFile can label binaries
// without importing the renderer-facing scheme handler.
const BINARY_MIME = {
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', mp3: 'audio/mpeg', wav: 'audio/wav',
  mp4: 'video/mp4', mov: 'video/quicktime', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', exe: 'application/octet-stream',
  bin: 'application/octet-stream', so: 'application/octet-stream',
  dylib: 'application/octet-stream', wasm: 'application/wasm',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Heuristic binary sniff: a NUL byte in the first 8 KB ⇒ treat as binary.
 *  O(min(n, 8192)) — bounded by the sample, not file size. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function readFile(filePath) {
  let resolved;
  try { resolved = validateHomePath(filePath); }
  catch (e) { return { ok: false, text: '', error: e.message, size: 0 }; }

  try {
    const st = await fsp.stat(resolved);
    if (st.isDirectory()) return { ok: false, text: '', error: 'Path is a directory', size: 0 };
    const ext = resolved.toLowerCase().split('.').pop() || '';
    const mime = BINARY_MIME[ext] || 'application/octet-stream';
    // 5 MB cap — preview pane shouldn't try to load huge logs. Oversize files
    // report as binary so the renderer shows the fallback pane (Open externally)
    // rather than a bare error string.
    if (st.size > 5 * 1024 * 1024) {
      return { ok: false, text: '', error: 'File too large to preview (> 5 MB)', size: st.size, binary: true, mime };
    }
    const buf = await fsp.readFile(resolved);
    if (looksBinary(buf)) {
      return { ok: false, text: '', error: 'Binary file', size: st.size, binary: true, mime };
    }
    return { ok: true, text: buf.toString('utf8'), error: null, size: st.size, binary: false, mime };
  } catch (e) {
    return { ok: false, text: '', error: e.message, size: 0 };
  }
}

async function writeFile(filePath, content) {
  let resolved;
  try {
    resolved = validateHomePath(filePath);
    rejectCredentials(resolved);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  try {
    const dir = path.dirname(resolved);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, resolved);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function createEntry(parentPath, name, kind) {
  const nameError = validateName(name);
  if (nameError) return { ok: false, error: nameError };

  let parent;
  try { parent = validateHomePath(parentPath); }
  catch (e) { return { ok: false, error: e.message }; }

  const target = path.join(parent, name);
  // Re-validate target — name passed validateName but join could still
  // produce something outside parent (defense in depth).
  try { validateHomePath(target); }
  catch (e) { return { ok: false, error: e.message }; }
  try { rejectCredentials(target); }
  catch (e) { return { ok: false, error: e.message }; }

  try {
    const parentStat = await fsp.stat(parent);
    if (!parentStat.isDirectory()) {
      return { ok: false, error: 'Parent path is not a directory' };
    }
    try {
      await fsp.access(target);
      return { ok: false, error: 'A file or folder with that name already exists' };
    } catch { /* expected — doesn't exist */ }

    if (kind === 'folder') {
      await fsp.mkdir(target, { recursive: false });
    } else {
      // 'wx' is exclusive — fails if it races with another writer.
      await fsp.writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
    }
    return { ok: true, path: target, error: null };
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false, error: 'A file or folder with that name already exists' };
    return { ok: false, error: e.message };
  }
}

async function renameEntry(oldPath, newName) {
  const nameError = validateName(newName);
  if (nameError) return { ok: false, error: nameError };

  let resolvedOld;
  try { resolvedOld = validateHomePath(oldPath); }
  catch (e) { return { ok: false, error: e.message }; }

  const newPath = path.join(path.dirname(resolvedOld), newName);
  try { validateHomePath(newPath); }
  catch (e) { return { ok: false, error: e.message }; }
  try { rejectCredentials(newPath); }
  catch (e) { return { ok: false, error: e.message }; }

  try {
    await fsp.access(resolvedOld);
    try {
      await fsp.access(newPath);
      return { ok: false, error: 'A file or folder with that name already exists' };
    } catch { /* good */ }
    await fsp.rename(resolvedOld, newPath);
    return { ok: true, newPath, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const CRITICAL_PATHS = new Set([os.homedir(), '/', '/usr', '/bin', '/etc', '/var', '/System', '/Applications']);

async function deleteEntry(filePath) {
  let resolved;
  try { resolved = validateHomePath(filePath); }
  catch (e) { return { ok: false, error: e.message }; }

  if (CRITICAL_PATHS.has(resolved)) {
    return { ok: false, error: 'Cannot delete system-critical paths' };
  }
  try { rejectCredentials(resolved); }
  catch (e) { return { ok: false, error: e.message }; }

  try {
    // Prefer trash so deletes are recoverable. Fall back to hard delete only
    // if the platform doesn't support it (very old Linux desktops).
    try {
      await shell.trashItem(resolved);
      return { ok: true, error: null };
    } catch {
      const st = await fsp.lstat(resolved);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        await fsp.rm(resolved, { recursive: true });
      } else {
        await fsp.unlink(resolved);
      }
      return { ok: true, error: null };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function openExternal(filePath) {
  let resolved;
  try { resolved = validateHomePath(filePath); }
  catch (e) { return { ok: false, error: e.message }; }
  try {
    await fsp.access(resolved);
    const err = await shell.openPath(resolved);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function showInFinder(filePath) {
  let resolved;
  try { resolved = validateHomePath(filePath); }
  catch (e) { return { ok: false, error: e.message }; }
  try {
    await fsp.access(resolved);
    shell.showItemInFolder(resolved);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ──────────────────────────────────────────── schemas
const filesPath = z.object({ path: z.string().min(1).max(4096) });
const filesList = z.object({ path: z.string().min(1).max(4096), showHidden: z.boolean().optional() });
const filesWrite = z.object({ path: z.string().min(1).max(4096), content: z.string() });
const filesCreate = z.object({
  parentPath: z.string().min(1).max(4096),
  name: z.string().min(1).max(255),
  kind: z.enum(['file', 'folder']),
});
const filesRename = z.object({ path: z.string().min(1).max(4096), newName: z.string().min(1).max(255) });

function registerFilesHandlers() {
  ipcMain.handle('files:list', (_e, payload) => {
    const { path: p, showHidden } = filesList.parse(payload);
    return listDir(p, !!showHidden);
  });
  ipcMain.handle('files:read', (_e, payload) => {
    const { path: p } = filesPath.parse(payload);
    return readFile(p);
  });
  ipcMain.handle('files:write', (_e, payload) => {
    const { path: p, content } = filesWrite.parse(payload);
    return writeFile(p, content);
  });
  ipcMain.handle('files:create', (_e, payload) => {
    const { parentPath, name, kind } = filesCreate.parse(payload);
    return createEntry(parentPath, name, kind);
  });
  ipcMain.handle('files:rename', (_e, payload) => {
    const { path: p, newName } = filesRename.parse(payload);
    return renameEntry(p, newName);
  });
  ipcMain.handle('files:delete', (_e, payload) => {
    const { path: p } = filesPath.parse(payload);
    return deleteEntry(p);
  });
  ipcMain.handle('files:open-external', (_e, payload) => {
    const { path: p } = filesPath.parse(payload);
    return openExternal(p);
  });
  ipcMain.handle('files:show-in-finder', (_e, payload) => {
    const { path: p } = filesPath.parse(payload);
    return showInFinder(p);
  });
}

module.exports = {
  registerFilesHandlers,
  // exported for tests
  listDir,
  readFile,
  writeFile,
  createEntry,
  renameEntry,
  deleteEntry,
};
