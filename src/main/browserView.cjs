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

const path = require('path');
const crypto = require('crypto');
const { WebContentsView, shell } = require('electron');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

/** @type {Map<string, WebContentsView>} */
const views = new Map();
// webContents.id of every browser-view's webContents — index.cjs's global
// will-navigate handler consults this set to exempt browser views from the
// main-window nav lock without weakening the lock itself.
const browserViewContentsIds = new Set();
let win = null;

// ── Recorder engine (PRD 408) ─────────────────────────────────────────
// viewId <-> webContents.id so the record-event channel (sent from the
// page's isolated-preload bridge, which only knows its own sender) can be
// routed back to the right viewId's step stream.
const contentsIdToViewId = new Map();
const recordingViewIds = new Set();
const stepCounters = new Map();
// contextBridge.exposeInMainWorld puts the recorder toggle in the EMBEDDED
// PAGE's own JS context — an adversarial site being recorded could call it
// directly. The actual step-forwarding gate is `recordingViewIds` (only this
// module can set it), so a rogue page can't forge/exfiltrate anything, but it
// could still pause a legitimate session out from under the user. Close that
// with a per-view secret the page can't read: generated here, handed to the
// preload via `additionalArguments`/`process.argv` (never touches the DOM or
// a script tag the page could inspect), and required on every toggle call.
const recordTokens = new Map();

function emitRecordStep(viewId, partial) {
  const n = (stepCounters.get(viewId) || 0) + 1;
  stepCounters.set(viewId, n);
  sendIfAlive(win, `browser:record-step:${viewId}`, { n, ...partial });
}

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
  wc.on('did-navigate', (_e, url) => {
    emit();
    if (recordingViewIds.has(viewId)) emitRecordStep(viewId, { verb: 'navigate', target: url });
  });
  wc.on('did-navigate-in-page', emit);
  wc.on('page-title-updated', emit);
  wc.on('did-fail-load', (_e, errorCode) => {
    // -3 is ERR_ABORTED — fires on routine cancelled/superseded loads, not a
    // real failure. Skip so the renderer doesn't show a noisy error banner.
    if (errorCode === -3) return;
    emit();
  });
  // The recorder-preload's `capturing` flag lives in the page's JS context,
  // which is torn down on every navigation — re-arm it after each load so a
  // recording session survives the page it started on navigating away.
  wc.on('did-finish-load', () => {
    if (!recordingViewIds.has(viewId)) return;
    const token = recordTokens.get(viewId);
    wc.executeJavaScript(
      `window.__smRecorder && window.__smRecorder.setRecording(true, ${JSON.stringify(token)})`,
    ).catch(() => {});
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
  const recordToken = crypto.randomBytes(16).toString('hex');
  recordTokens.set(viewId, recordToken);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
      preload: path.join(__dirname, '..', 'preload', 'browserViewPreload.cjs'),
      additionalArguments: [`--sm-record-token=${recordToken}`],
    },
  });
  views.set(viewId, view);
  browserViewContentsIds.add(view.webContents.id);
  contentsIdToViewId.set(view.webContents.id, viewId);
  wireNavEvents(viewId, view);
  view.webContents.once('destroyed', () => {
    browserViewContentsIds.delete(view.webContents.id);
    contentsIdToViewId.delete(view.webContents.id);
    recordingViewIds.delete(viewId);
    stepCounters.delete(viewId);
    recordTokens.delete(viewId);
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
  contentsIdToViewId.delete(view.webContents.id);
  recordingViewIds.delete(viewId);
  stepCounters.delete(viewId);
  if (win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
  }
  try { view.webContents.close(); } catch { /* already closed */ }
  views.delete(viewId);
  return { ok: true };
}

function recordStart({ viewId }) {
  const view = views.get(viewId);
  if (!view) return { ok: false, error: 'unknown viewId' };
  recordingViewIds.add(viewId);
  stepCounters.set(viewId, 0);
  const token = recordTokens.get(viewId);
  view.webContents
    .executeJavaScript(`window.__smRecorder && window.__smRecorder.setRecording(true, ${JSON.stringify(token)})`)
    .catch(() => {});
  return { ok: true };
}

function recordStop({ viewId }) {
  recordingViewIds.delete(viewId);
  const view = views.get(viewId);
  if (view && !view.webContents.isDestroyed()) {
    const token = recordTokens.get(viewId);
    view.webContents
      .executeJavaScript(`window.__smRecorder && window.__smRecorder.setRecording(false, ${JSON.stringify(token)})`)
      .catch(() => {});
  }
  return { ok: true };
}

// Sent by the recorder-preload's contextBridge (never the page itself — the
// page has no node/ipcRenderer access under sandbox+contextIsolation). Only
// forwarded while the view is actually in a recording session, and only the
// two verbs the preload emits; typed values are never included (privacy
// invariant — "sandboxed · no filesystem · no passwords").
function handleRecordEvent(event, payload) {
  const viewId = contentsIdToViewId.get(event.sender.id);
  if (!viewId || !recordingViewIds.has(viewId)) return;
  const verb = payload && payload.verb;
  if (verb !== 'click' && verb !== 'type') return;
  const target = typeof payload.target === 'string' ? payload.target.slice(0, 300) : '';
  const step = { verb, target };
  if (verb === 'type') {
    step.masked = true;
    if (typeof payload.variableSuggestion === 'string') {
      step.variableSuggestion = payload.variableSuggestion.slice(0, 64);
    }
  }
  emitRecordStep(viewId, step);
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

// Cap returned capture text so a huge DOM can't blow up the IPC channel.
const CAPTURE_TEXT_MAX = 500_000;

// PRD 407: grab page text/HTML for the Capture panel. Reuses the same
// executeJavaScript access path the recorder-preload re-arm already uses
// above (did-finish-load handler) — one round trip returns url/title/text
// together instead of three separate calls.
async function captureDom({ viewId, kind }) {
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  try {
    const script = kind === 'html'
      ? '({ url: location.href, title: document.title, text: document.documentElement.outerHTML })'
      : '({ url: location.href, title: document.title, text: document.body ? document.body.innerText : "" })';
    const result = await view.webContents.executeJavaScript(script);
    let text = typeof result?.text === 'string' ? result.text : '';
    let truncated = false;
    if (text.length > CAPTURE_TEXT_MAX) {
      text = text.slice(0, CAPTURE_TEXT_MAX);
      truncated = true;
    }
    return { ok: true, url: result?.url || '', title: result?.title || '', text, truncated };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// PRD 407: screenshot the active browser sub-tab as a PNG data URL.
async function captureShot({ viewId }) {
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  try {
    const wc = view.webContents;
    const image = await wc.capturePage();
    const dataUrl = image.toDataURL();
    return { ok: true, url: wc.getURL(), title: wc.getTitle(), dataUrl };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
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
  ipcMain.handle('browser:record-start', validated(schemas.browserViewId, (payload) => recordStart(payload)));
  ipcMain.handle('browser:record-stop', validated(schemas.browserViewId, (payload) => recordStop(payload)));
  ipcMain.on('browser:record-event', handleRecordEvent);
  ipcMain.handle('browser:capture-dom', validated(schemas.browserCaptureDom, (payload) => captureDom(payload)));
  ipcMain.handle('browser:capture-shot', validated(schemas.browserViewId, (payload) => captureShot(payload)));
  ipcMain.handle('browser:save-binary', validated(schemas.browserSaveBinary, (payload) => {
    const { writeBinaryAtomic } = require('./config.cjs');
    return writeBinaryAtomic(payload.path, Buffer.from(payload.base64, 'base64'))
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
  }));
}

module.exports = { registerBrowserView, attachWindow, views, isBrowserViewContents };
