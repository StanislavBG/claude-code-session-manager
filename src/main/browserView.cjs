/**
 * Owns the native WebContentsView(s) that embed real web content inside the
 * Browser tab. `<webview>` and iframes are blocked app-wide (see index.cjs
 * will-attach-webview + CSP frame-src 'none'), so this is the only way to
 * show remote content: a WebContentsView is a sibling layer the main process
 * positions directly on top of the renderer's BrowserWindow, keyed by a
 * renderer-generated viewId.
 *
 * PRD 399 created/positioned/showed/hid/destroyed the view. This PRD (400)
 * adds real navigation: browser:navigate/back/forward/reload/stop, nav-state
 * broadcasts, the will-navigate nav-lock exemption (index.cjs allows this
 * view's webContents to navigate anywhere while the main window stays
 * locked), external-link routing, and download blocking. Bounds reporting
 * from a ResizeObserver remains out of scope (PRD 401).
 */

const { WebContentsView, shell } = require('electron');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

/** @type {Map<string, WebContentsView>} */
const views = new Map();
// webContents.id of every browser-view's webContents — index.cjs's global
// will-navigate handler consults this set to exempt browser views from the
// main-window nav lock without weakening the lock itself.
const browserViewContentsIds = new Set();
let win = null;

function attachWindow(mainWindow) {
  win = mainWindow;
}

function isBrowserViewContents(id) {
  return browserViewContentsIds.has(id);
}

function normalizeUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return { ok: false, error: 'empty url' };
  if (/^https?:\/\//i.test(url)) {
    // already has an allowed scheme
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    // has some other scheme with an authority (file://, chrome://, etc.) — reject
    return { ok: false, error: `disallowed scheme in "${rawUrl}"` };
  } else if (/^javascript:/i.test(url) || /^data:/i.test(url)) {
    // schemes with no "//" authority that are still dangerous — reject explicitly
    return { ok: false, error: `disallowed scheme in "${rawUrl}"` };
  } else {
    // bare host[:port]/path — assume https
    url = `https://${url}`;
  }
  if (!/^https:\/\//i.test(url) && !/^http:\/\//i.test(url)) {
    return { ok: false, error: `disallowed scheme in "${rawUrl}"` };
  }
  // Upgrade http:// to https:// per AC (loadURL still allowed to redirect
  // back down if the site truly has no https, but we always request https first).
  if (/^http:\/\//i.test(url)) {
    url = `https://${url.slice('http://'.length)}`;
  }
  return { ok: true, url };
}

function broadcastNavState(viewId, view) {
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  const url = wc.getURL();
  sendIfAlive(win, `browser:nav-state:${viewId}`, {
    url,
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
    loading: wc.isLoading(),
    isSecure: /^https:/i.test(url),
  });
}

function wireNavEvents(viewId, view) {
  const wc = view.webContents;
  const emit = () => broadcastNavState(viewId, view);

  wc.on('did-start-navigation', emit);
  wc.on('did-navigate', emit);
  wc.on('did-navigate-in-page', emit);
  wc.on('page-title-updated', emit);
  wc.on('did-fail-load', (_e, errorCode) => {
    // -3 is ERR_ABORTED — fires on routine cancelled/superseded loads, not a
    // real failure. Skip so the renderer doesn't show a noisy error banner.
    if (errorCode === -3) return;
    emit();
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  wc.session.on('will-download', (event) => {
    event.preventDefault();
  });
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
  browserViewContentsIds.add(view.webContents.id);
  wireNavEvents(viewId, view);
  view.webContents.once('destroyed', () => {
    browserViewContentsIds.delete(view.webContents.id);
  });
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
  browserViewContentsIds.delete(view.webContents.id);
  if (win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
  }
  try { view.webContents.close(); } catch { /* already closed */ }
  views.delete(viewId);
  return { ok: true };
}

function navigate({ viewId, url }) {
  const view = views.get(viewId);
  if (!view) return { ok: false, error: 'unknown viewId' };
  const normalized = normalizeUrl(url);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  view.webContents.loadURL(normalized.url).catch(() => {
    // Load failures surface via did-fail-load → broadcastNavState; nothing
    // further to do here.
  });
  return { ok: true };
}

function back({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: false, error: 'unknown viewId' };
  const wc = view.webContents;
  const nav = wc.navigationHistory;
  const canGoBack = nav ? nav.canGoBack() : wc.canGoBack();
  if (!canGoBack) return { ok: false, error: 'cannot go back' };
  if (nav) nav.goBack(); else wc.goBack();
  return { ok: true };
}

function forward({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: false, error: 'unknown viewId' };
  const wc = view.webContents;
  const nav = wc.navigationHistory;
  const canGoForward = nav ? nav.canGoForward() : wc.canGoForward();
  if (!canGoForward) return { ok: false, error: 'cannot go forward' };
  if (nav) nav.goForward(); else wc.goForward();
  return { ok: true };
}

function reload({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: false, error: 'unknown viewId' };
  view.webContents.reload();
  return { ok: true };
}

function stop({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: false, error: 'unknown viewId' };
  view.webContents.stop();
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
  ipcMain.handle('browser:navigate', validated(schemas.browserNavigate, (payload) => navigate(payload)));
  ipcMain.handle('browser:back', validated(schemas.browserViewId, (payload) => back(payload)));
  ipcMain.handle('browser:forward', validated(schemas.browserViewId, (payload) => forward(payload)));
  ipcMain.handle('browser:reload', validated(schemas.browserViewId, (payload) => reload(payload)));
  ipcMain.handle('browser:stop', validated(schemas.browserViewId, (payload) => stop(payload)));
}

module.exports = { registerBrowserView, attachWindow, views, isBrowserViewContents };
