/**
 * docEditor.cjs — Doc Editor IPC (PRD 04).
 *
 * Three handlers:
 *   doc-editor:pick-file   open native file picker, return validated path
 *   doc-editor:read-file   read a text file, return { ok, text, mtimeMs }
 *   doc-editor:write-file  atomic write, return { ok, mtimeMs }
 *
 * Write policy: uses validatePath (home-dir boundary) but NOT validateWrite
 * (which would restrict to .claude/ / .config/ directories). The doc editor
 * writes to user-chosen files anywhere in the home tree.
 */

const { ipcMain, dialog, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validatePath } = require('./config.cjs');

async function writeDocAtomic(abs, text) {
  const real = validatePath(abs);
  const dir = path.dirname(real);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${real}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, real);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* */ }
    throw e;
  }
  const stat = await fsp.stat(real);
  return { ok: true, mtimeMs: stat.mtimeMs };
}

function registerDocEditorHandlers() {
  ipcMain.handle('doc-editor:pick-file', async (event, payload) => {
    const lastDir = (typeof payload === 'object' && payload?.lastDir) ? payload.lastDir : os.homedir();
    // Resolve the window from the sender so registration order doesn't matter.
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, {
      defaultPath: lastDir,
      properties: ['openFile'],
      filters: [
        { name: 'Text / Markdown', extensions: ['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'sh'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { path: null };
    let real;
    try {
      real = validatePath(result.filePaths[0]);
    } catch (e) {
      return { path: null, error: e.message };
    }
    return { path: real };
  });

  ipcMain.handle('doc-editor:read-file', async (_e, payload) => {
    const p = payload && typeof payload.path === 'string' ? payload.path : null;
    if (!p) return { ok: false, error: 'path required' };
    let real;
    try {
      real = validatePath(p);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    try {
      const [text, stat] = await Promise.all([
        fsp.readFile(real, 'utf8'),
        fsp.stat(real),
      ]);
      return { ok: true, text, mtimeMs: stat.mtimeMs };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('doc-editor:write-file', async (_e, payload) => {
    const p = payload && typeof payload.path === 'string' ? payload.path : null;
    const text = payload && typeof payload.text === 'string' ? payload.text : null;
    if (!p) return { ok: false, error: 'path required' };
    if (text === null) return { ok: false, error: 'text required' };
    try {
      return await writeDocAtomic(p, text);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { registerDocEditorHandlers };
