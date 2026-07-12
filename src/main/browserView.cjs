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
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { WebContentsView } = require('electron');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { readJson, writeJson } = require('./config.cjs');
const {
  parseKeyCombo,
  computeScrollDelta,
  computeScreenshotScale,
} = require('./lib/browserAgentActions.cjs');

// ── History + zoom persistence (PRD 402) ──────────────────────────────
// Both files live under ~/.claude/session-manager/browser/, inside
// config.cjs's WRITE_PREFIXES allowlist, and are written through
// config.cjs's writeJson (tmp+rename atomic write) — never re-implemented.
const BROWSER_DATA_DIR = path.join(os.homedir(), '.claude', 'session-manager', 'browser');
const HISTORY_PATH = path.join(BROWSER_DATA_DIR, 'history.json');
const ZOOM_PATH = path.join(BROWSER_DATA_DIR, 'zoom.json');
const HISTORY_MAX = 500;

let lastZoomFactor = 1;
// Startup-only, fixed constant path (not user input) — a plain sync read is
// simpler than threading an async load through registerBrowserView's callers.
function loadPersistedZoom() {
  try {
    const raw = fs.readFileSync(ZOOM_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.factor === 'number' && Number.isFinite(data.factor)) {
      lastZoomFactor = data.factor;
    }
  } catch {
    // no persisted zoom yet — keep default 1
  }
}

// Serializes read-modify-write cycles against history.json so concurrent
// navigations across multiple sub-tabs can't race and drop entries.
let historyWriteChain = Promise.resolve();
function appendHistoryEntry({ url, title }) {
  if (!url || url === 'about:blank') return;
  historyWriteChain = historyWriteChain.then(async () => {
    try {
      const existing = await readJson(HISTORY_PATH);
      const list = Array.isArray(existing.data) ? existing.data : [];
      list.unshift({ url, title: title || '', ts: Date.now() });
      await writeJson(HISTORY_PATH, list.slice(0, HISTORY_MAX));
    } catch {
      // best-effort — history is a convenience, not load-bearing
    }
  });
}

/** @type {Map<string, WebContentsView>} */
const views = new Map();
// webContents.id of every browser-view's webContents — index.cjs's global
// will-navigate handler consults this set to exempt browser views from the
// main-window nav lock without weakening the lock itself.
const browserViewContentsIds = new Set();
let win = null;
// Last viewId shown via show() — the renderer's proxy for "which sub-tab is
// active", since WebContentsView exposes setVisible() but no getter. Used to
// default viewId-optional browser-agent-server routes to the active tab.
let lastShownViewId = null;

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

// viewId -> last search text passed to findInPage, so repeat calls with the
// same text advance to the next/previous match (findNext: true) while a new
// search term restarts the highlight pass (findNext: false).
const lastFindText = new Map();

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
    // wc.getTitle() here still reports the PREVIOUS page's title — the new
    // page's <title> hasn't parsed yet. Wait one tick for dom-ready so the
    // history entry gets the title of the page actually navigated to.
    wc.once('dom-ready', () => appendHistoryEntry({ url, title: wc.getTitle() }));
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
      sendIfAlive(win, 'browser:open-tab-request', { url });
    }
    return { action: 'deny' };
  });

  wc.session.on('will-download', (event) => {
    event.preventDefault();
  });

  wc.on('found-in-page', (_e, result) => {
    sendIfAlive(win, `browser:find-result:${viewId}`, {
      requestId: result.requestId,
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal,
    });
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
  view.webContents.setZoomFactor(lastZoomFactor);
  wireNavEvents(viewId, view);
  view.webContents.once('destroyed', () => {
    browserViewContentsIds.delete(view.webContents.id);
    contentsIdToViewId.delete(view.webContents.id);
    recordingViewIds.delete(viewId);
    stepCounters.delete(viewId);
    recordTokens.delete(viewId);
    lastFindText.delete(viewId);
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
  lastShownViewId = viewId;
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
  lastFindText.delete(viewId);
  if (lastShownViewId === viewId) lastShownViewId = null;
  if (win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
  }
  try { view.webContents.close(); } catch { /* already closed */ }
  views.delete(viewId);
  return { ok: true };
}

// PRD 402: address-bar zoom control. Factor is clamped to Chromium's own
// findInPage-adjacent zoom range and persisted so the next-opened tab (and
// next app launch, via loadPersistedZoom) starts at the last value used.
function setZoom({ viewId, factor }) {
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  const clamped = Math.min(3, Math.max(0.25, Number(factor) || 1));
  view.webContents.setZoomFactor(clamped);
  lastZoomFactor = clamped;
  writeJson(ZOOM_PATH, { factor: clamped }).catch(() => {});
  return { ok: true, factor: clamped };
}

// PRD 402: Cmd/Ctrl+F find bar. Empty text clears the search instead of
// running an empty findInPage query (Electron throws on '').
function find({ viewId, text, forward }) {
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  if (!text) {
    view.webContents.stopFindInPage('clearSelection');
    lastFindText.delete(viewId);
    return { ok: true };
  }
  const isRepeat = lastFindText.get(viewId) === text;
  lastFindText.set(viewId, text);
  view.webContents.findInPage(text, { forward: forward !== false, findNext: isRepeat });
  return { ok: true };
}

function stopFind({ viewId }) {
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  view.webContents.stopFindInPage('clearSelection');
  lastFindText.delete(viewId);
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
  if (verb !== 'click' && verb !== 'type' && verb !== 'drag') return;
  const target = typeof payload.target === 'string' ? payload.target.slice(0, 300) : '';
  const step = { verb, target };
  if (verb === 'type') {
    step.masked = true;
    if (typeof payload.variableSuggestion === 'string') {
      step.variableSuggestion = payload.variableSuggestion.slice(0, 64);
    }
  }
  if (verb === 'click') {
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (Number.isFinite(x)) step.x = x;
    if (Number.isFinite(y)) step.y = y;
  }
  if (verb === 'drag') {
    if (typeof payload.endTarget === 'string') step.endTarget = payload.endTarget.slice(0, 300);
    for (const key of ['x', 'y', 'endX', 'endY']) {
      const n = Number(payload[key]);
      if (Number.isFinite(n)) step[key] = n;
    }
  }
  emitRecordStep(viewId, step);
}

// ── Replay engine (PRD 410) ───────────────────────────────────────────
// Each step is bounded so a bad/stale selector can't hang the run; the
// caller supplies `steps` (renderer owns the recorded step list — the main
// process never persists them), so replay is stateless between calls.
const REPLAY_STEP_TIMEOUT_MS = 10_000;
const REPLAY_WAIT_POLL_MS = 250;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function replayPositionedClick(wc, x, y) {
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

async function replayClickOrType(wc, step, values) {
  if (step.verb === 'click' && Number.isFinite(step.x) && Number.isFinite(step.y)) {
    await replayPositionedClick(wc, step.x, step.y);
    return;
  }
  const script =
    step.verb === 'type'
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(step.target)});
          if (!el) return false;
          el.focus();
          // React (and similar frameworks) override the native value setter
          // to track state; assigning el.value directly leaves that tracked
          // state stale, so the framework's onChange never fires. Go through
          // the native prototype setter — the same workaround React Testing
          // Library / Playwright use — so the dispatched 'input' event is
          // seen as a real change.
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(el, ${JSON.stringify(step.variable && values[step.variable] !== undefined ? String(values[step.variable]) : '')});
          } else {
            el.value = ${JSON.stringify(step.variable && values[step.variable] !== undefined ? String(values[step.variable]) : '')};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`
      : step.verb === 'select'
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(step.target)});
            if (!el) return false;
            el.value = ${JSON.stringify(step.value ?? '')};
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`
        : `(() => {
            const el = document.querySelector(${JSON.stringify(step.target)});
            if (!el) return false;
            el.click();
            return true;
          })()`;
  const found = await withTimeout(wc.executeJavaScript(script), REPLAY_STEP_TIMEOUT_MS, step.verb);
  if (!found) throw new Error(`selector not found: ${step.target}`);
}

async function replayWaitFor(wc, step) {
  const target = step.target;
  const deadline = Date.now() + REPLAY_STEP_TIMEOUT_MS;
  const checkScript = `(() => {
    try {
      return (document.body && document.body.innerText.includes(${JSON.stringify(target)})) || location.href.includes(${JSON.stringify(target)});
    } catch { return false; }
  })()`;
  for (;;) {
    const found = await wc.executeJavaScript(checkScript).catch(() => false);
    if (found) return;
    if (Date.now() >= deadline) throw new Error(`wait-for timed out: ${target}`);
    await new Promise((r) => setTimeout(r, REPLAY_WAIT_POLL_MS));
  }
}

const REPLAY_DRAG_STEPS = 3;

async function replayDrag(wc, step) {
  const { x, y, endX, endY } = step;
  if (![x, y, endX, endY].every((n) => Number.isFinite(n))) {
    throw new Error('drag step missing coordinates');
  }
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= REPLAY_DRAG_STEPS; i += 1) {
    const t = i / REPLAY_DRAG_STEPS;
    wc.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(x + (endX - x) * t),
      y: Math.round(y + (endY - y) * t),
    });
  }
  wc.sendInputEvent({ type: 'mouseUp', x: endX, y: endY, button: 'left', clickCount: 1 });
}

async function replayStep(view, step, values) {
  const wc = view.webContents;
  if (step.verb === 'navigate') {
    const normalized = normalizeUrl(step.target);
    if (!normalized.ok) throw new Error(normalized.error);
    await withTimeout(wc.loadURL(normalized.url), REPLAY_STEP_TIMEOUT_MS, 'navigate');
    return;
  }
  if (step.verb === 'click' || step.verb === 'type' || step.verb === 'select') {
    await replayClickOrType(wc, step, values);
    return;
  }
  if (step.verb === 'wait-for') {
    await replayWaitFor(wc, step);
    return;
  }
  if (step.verb === 'drag') {
    await withTimeout(replayDrag(wc, step), REPLAY_STEP_TIMEOUT_MS, 'drag');
    return;
  }
  throw new Error(`unsupported step verb: ${step.verb}`);
}

// `continueOnError` defaults to false: replay stops at the first failed step
// (fail-fast, matches the transport's "pass/fail per step" model) — the
// caller can opt into running every step regardless by passing `true`.
//
// Replayed navigations/clicks/types are synthetic but indistinguishable from
// real user input to the recorder's own listeners (did-navigate,
// browser:record-event) — without suppressing capture here, replaying a
// session that's still "recording" (armed until stop, not just paused; see
// browser.ts toggleRecordingPause) would re-append every replayed step back
// into the step list. Drop the viewId out of recordingViewIds for the
// duration of the run and restore its prior membership afterward.
async function replay({ viewId, steps, values, continueOnError }) {
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  const stepList = Array.isArray(steps) ? steps : [];
  const resolvedValues = values || {};
  const wasRecording = recordingViewIds.has(viewId);
  recordingViewIds.delete(viewId);
  try {
    for (const step of stepList) {
      try {
        await replayStep(view, step, resolvedValues);
        sendIfAlive(win, `browser:replay-step:${viewId}`, { n: step.n, status: 'pass' });
      } catch (e) {
        const detail = e && e.message ? e.message : String(e);
        sendIfAlive(win, `browser:replay-step:${viewId}`, { n: step.n, status: 'fail', detail });
        if (!continueOnError) return { ok: true, stopped: true, failedAt: step.n };
      }
    }
    return { ok: true, stopped: false };
  } finally {
    if (wasRecording) recordingViewIds.add(viewId);
  }
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

// ── On-demand single-action agent API (PRD 535 foundation) ────────────
// Modeled on Anthropic's published computer_use tool schema. Reuses the same
// dispatch primitives the Recorder replay engine already established above
// (replayPositionedClick for coordinate clicks, normalizeUrl/withTimeout for
// navigate) instead of forking a second copy — the difference from replay()
// is that this drives ONE ad-hoc action at a time by raw coordinate, not a
// recorded `steps` array by selector.
function listViews() {
  const result = [];
  for (const [viewId, view] of views.entries()) {
    if (view.webContents.isDestroyed()) continue;
    result.push({
      viewId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      active: viewId === lastShownViewId,
    });
  }
  return result;
}

function resolveViewId(viewId) {
  return viewId || lastShownViewId;
}

async function dispatchAction(view, params) {
  const wc = view.webContents;
  switch (params.action) {
    case 'left_click': {
      const [x, y] = Array.isArray(params.coordinate) ? params.coordinate : [];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('left_click requires coordinate: [x, y]');
      }
      await replayPositionedClick(wc, x, y);
      return { ok: true };
    }
    case 'type': {
      if (typeof params.text !== 'string') throw new Error('type requires text');
      await wc.insertText(params.text);
      return { ok: true };
    }
    case 'key': {
      if (typeof params.key !== 'string' || !params.key) throw new Error('key requires key');
      const { keyCode, modifiers } = parseKeyCombo(params.key);
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      return { ok: true };
    }
    case 'scroll': {
      const [x, y] = Array.isArray(params.coordinate) ? params.coordinate : [0, 0];
      const { deltaX, deltaY } = computeScrollDelta(params);
      wc.sendInputEvent({ type: 'mouseWheel', x: Number(x) || 0, y: Number(y) || 0, deltaX, deltaY });
      return { ok: true };
    }
    case 'navigate': {
      if (typeof params.url !== 'string' || !params.url) throw new Error('navigate requires url');
      const normalized = normalizeUrl(params.url);
      if (!normalized.ok) throw new Error(normalized.error);
      await withTimeout(wc.loadURL(normalized.url), REPLAY_STEP_TIMEOUT_MS, 'navigate');
      return { ok: true };
    }
    default:
      throw new Error(`unsupported action: ${params.action}`);
  }
}

// Single-action entry point (as opposed to replay()'s recorded-steps-array
// entry point) — resolves viewId (defaulting to the active tab), dispatches
// exactly one action, and normalizes errors into the { ok, error } shape the
// rest of this module already uses.
async function dispatchViewAction(params) {
  const viewId = resolveViewId(params.viewId);
  if (!viewId) return { ok: false, error: 'no viewId given and no active tab' };
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  try {
    return await dispatchAction(view, params);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// On-demand screenshot for the agent API. Reuses wc.capturePage() (same call
// captureShot() below already uses) but additionally resizes to a fixed
// logical resolution — Anthropic's computer-use API silently downscales
// oversized screenshots server-side, which breaks coordinate mapping unless
// caller and model agree on one fixed max dimension. `scale` in the response
// lets a caller map a coordinate clicked on the returned image back to the
// real page: realX = clickedX / scale.
async function captureShotForAgent({ viewId } = {}) {
  const id = resolveViewId(viewId);
  if (!id) return { ok: false, error: 'no viewId given and no active tab' };
  const view = views.get(id);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  try {
    const wc = view.webContents;
    const image = await wc.capturePage();
    const { width, height } = image.getSize();
    const target = computeScreenshotScale(width, height);
    const resized = target.scale < 1 ? image.resize({ width: target.width, height: target.height }) : image;
    return {
      ok: true,
      viewId: id,
      url: wc.getURL(),
      title: wc.getTitle(),
      dataUrl: resized.toDataURL(),
      scale: target.scale,
      width: target.width,
      height: target.height,
      originalWidth: width,
      originalHeight: height,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Cheap text/accessibility-style snapshot for the agent API — an alternative
// to vision-only driving since a real DOM is available here. Follows the
// same executeJavaScript sandboxing pattern as captureDom() below (plain
// IIFE returning a plain object, no new capability granted to the page).
// Kept cheap on purpose: innerText + a capped list of interactive elements
// with center-point coordinates, no full HTML serialization or computed
// style walking.
const AGENT_DOM_TEXT_MAX = 100_000;
const AGENT_DOM_ELEMENT_LIMIT = 200;

async function captureAgentDom({ viewId } = {}) {
  const id = resolveViewId(viewId);
  if (!id) return { ok: false, error: 'no viewId given and no active tab' };
  const view = views.get(id);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  try {
    const script = `(() => {
      const SEL = 'button, a[href], input, textarea, select, [role="button"], [onclick]';
      const els = Array.from(document.querySelectorAll(SEL)).slice(0, ${AGENT_DOM_ELEMENT_LIMIT});
      const elements = els.map((el) => {
        const rect = el.getBoundingClientRect();
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120);
        return {
          tag: el.tagName.toLowerCase(),
          label,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }).filter((e) => e.x >= 0 && e.y >= 0 && Number.isFinite(e.x) && Number.isFinite(e.y));
      return {
        url: location.href,
        title: document.title,
        text: document.body ? document.body.innerText : '',
        elements,
      };
    })()`;
    const result = await view.webContents.executeJavaScript(script);
    let text = typeof result?.text === 'string' ? result.text : '';
    let truncated = false;
    if (text.length > AGENT_DOM_TEXT_MAX) {
      text = text.slice(0, AGENT_DOM_TEXT_MAX);
      truncated = true;
    }
    return {
      ok: true,
      viewId: id,
      url: result?.url || '',
      title: result?.title || '',
      text,
      truncated,
      elements: Array.isArray(result?.elements) ? result.elements : [],
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
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

// PRD 403: getter passed to browserCapture.cjs's registerBrowserCapture so
// the picker can reach a live WebContentsView without this module exposing
// its whole `views` Map as a mutable dependency surface.
function getView(viewId) {
  return views.get(viewId);
}

function registerBrowserView({ mainWindow, ipcMain }) {
  attachWindow(mainWindow);
  loadPersistedZoom();
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
  ipcMain.handle('browser:replay', validated(schemas.browserReplay, (payload) => replay(payload)));
  ipcMain.handle('browser:capture-dom', validated(schemas.browserCaptureDom, (payload) => captureDom(payload)));
  ipcMain.handle('browser:capture-shot', validated(schemas.browserViewId, (payload) => captureShot(payload)));
  ipcMain.handle('browser:set-zoom', validated(schemas.browserSetZoom, (payload) => setZoom(payload)));
  ipcMain.handle('browser:find', validated(schemas.browserFind, (payload) => find(payload)));
  ipcMain.handle('browser:stop-find', validated(schemas.browserViewId, (payload) => stopFind(payload)));
  ipcMain.handle('browser:save-binary', validated(schemas.browserSaveBinary, (payload) => {
    const { writeBinaryAtomic } = require('./config.cjs');
    return writeBinaryAtomic(payload.path, Buffer.from(payload.base64, 'base64'))
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
  }));
}

module.exports = {
  registerBrowserView,
  attachWindow,
  views,
  isBrowserViewContents,
  getView,
  listViews,
  dispatchViewAction,
  captureShotForAgent,
  captureAgentDom,
};
