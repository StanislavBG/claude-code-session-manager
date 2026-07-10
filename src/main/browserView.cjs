/**
 * Owns the native WebContentsView(s) that embed real web content inside the
 * Browser tab. `<webview>` and iframes are blocked app-wide (see index.cjs
 * will-attach-webview + CSP frame-src 'none'), so this is the only way to
 * show remote content: a WebContentsView is a sibling layer the main process
 * positions directly on top of the renderer's BrowserWindow, keyed by a
 * renderer-generated viewId.
 *
 * This PRD only creates/positions/shows/hides/destroys the view. Navigation,
 * the nav-lock exemption, and did-navigate wiring are out of scope (PRD 400);
 * bounds reporting from a ResizeObserver is PRD 401.
 */

const { WebContentsView } = require('electron');

/** @type {Map<string, WebContentsView>} */
const views = new Map();
let win = null;

function attachWindow(mainWindow) {
  win = mainWindow;
}

function create({ viewId, partition }) {
  if (views.has(viewId)) return { ok: true };
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
    },
  });
  views.set(viewId, view);
  if (win && !win.isDestroyed()) {
    win.contentView.addChildView(view);
  }
  return { ok: true };
}

function setBounds({ viewId, x, y, width, height }) {
  const view = views.get(viewId);
  if (!view) return { ok: false };
  view.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
  return { ok: true };
}

function show({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: false };
  view.setVisible(true);
  return { ok: true };
}

function hide({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: false };
  view.setVisible(false);
  return { ok: true };
}

function destroy({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: true };
  if (win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
  }
  try { view.webContents.close(); } catch { /* already closed */ }
  views.delete(viewId);
  return { ok: true };
}

function registerBrowserView({ mainWindow, ipcMain }) {
  attachWindow(mainWindow);
  const { schemas, validated } = require('./ipcSchemas.cjs');
  ipcMain.handle('browser:create', validated(schemas.browserCreate, (payload) => create(payload)));
  ipcMain.handle('browser:set-bounds', validated(schemas.browserSetBounds, (payload) => setBounds(payload)));
  ipcMain.handle('browser:show', validated(schemas.browserViewId, (payload) => show(payload)));
  ipcMain.handle('browser:hide', validated(schemas.browserViewId, (payload) => hide(payload)));
  ipcMain.handle('browser:destroy', validated(schemas.browserViewId, (payload) => destroy(payload)));
}

module.exports = { registerBrowserView, attachWindow, views };
