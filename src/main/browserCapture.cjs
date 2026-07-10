/**
 * DOM Capture element picker (PRD 403). Foundation for the capture panel
 * (PRD 406): while capture mode is active, injects a hover-highlight overlay
 * into the embedded page and lets the user hover/click to build a selection,
 * then reports a robust selector back to the renderer.
 *
 * The view is a sandboxed WebContentsView with no reachable app globals, so
 * the picker itself has to be a self-contained IIFE delivered via
 * `webContents.executeJavaScript(PICKER_SCRIPT, true)` — it cannot assume
 * any preload bridge. Getting picks back out of that unprivileged context:
 * the injected script buffers events on `window.__smPicker` and this module
 * polls `window.__smPicker.drain()` on an interval while picking is active
 * (the "polling drain" option called out in the PRD notes — simpler and
 * more robust than scraping `console-message` for a sentinel prefix, and
 * needs no wiring beyond executeJavaScript, which this module already uses
 * for start/stop/drain).
 *
 * SELECTOR_CHAIN_SOURCE is the single source of truth for the selector
 * fallback chain ([data-testid] -> [id] -> role+accessible-name -> minimal
 * unique CSS path -> nth-of-type XPath). PRD 408's recorder injection should
 * reuse this exact constant rather than growing a second selector generator.
 */

const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

let win = null;

function attachWindow(mainWindow) {
  win = mainWindow;
}

// ── Selector chain (single source of truth — see file header) ─────────
const SELECTOR_CHAIN_SOURCE = `
  function __smCssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      var seg = tag;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      var candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) {}
      node = parent;
    }
    return null;
  }
  function __smXPath(el) {
    var xparts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      var index = 1;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        index = siblings.indexOf(node) + 1;
      }
      xparts.unshift(tag + '[' + index + ']');
      node = parent;
    }
    return '/' + xparts.join('/');
  }
  function __smSelectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    try {
      var testId = el.getAttribute && el.getAttribute('data-testid');
      if (testId) return '[data-testid=' + JSON.stringify(testId) + ']';
      if (el.id) return '#' + CSS.escape(el.id);
      var role = el.getAttribute && el.getAttribute('role');
      var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (role && ariaLabel) return '[role=' + JSON.stringify(role) + '][aria-label=' + JSON.stringify(ariaLabel) + ']';
      var css = __smCssPath(el);
      if (css) return css;
      return __smXPath(el);
    } catch (e) {
      return el.tagName ? el.tagName.toLowerCase() : '';
    }
  }
`;

// ── Injected picker overlay ─────────────────────────────────────────
// Neutral high-contrast accent (matches docs/design/browser-tab.design.jsx
// terracotta) since the highlight renders inside third-party page content.
const PICKER_SCRIPT = `
(function () {
  if (window.__smPicker) return;
  ${SELECTOR_CHAIN_SOURCE}

  var ACCENT = '#b85c34';
  var events = [];
  var hovered = null;
  var selected = new Map();

  function labelFor(el) {
    var text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    return text.slice(0, 60);
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  function baseStyle(el, extra) {
    el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' + extra;
  }

  var hoverBox = document.createElement('div');
  baseStyle(hoverBox, 'border:2px dashed ' + ACCENT + ';display:none;');
  var selectedLayer = document.createElement('div');
  baseStyle(selectedLayer, '');
  var labelEl = document.createElement('div');
  baseStyle(labelEl, 'background:' + ACCENT + ';color:#fff;font:11px/1.4 monospace;padding:2px 6px;border-radius:3px;display:none;white-space:nowrap;');
  document.documentElement.appendChild(hoverBox);
  document.documentElement.appendChild(selectedLayer);
  document.documentElement.appendChild(labelEl);

  function isOverlay(el) {
    return el === hoverBox || el === selectedLayer || el === labelEl || selectedLayer.contains(el);
  }

  function drawSelected() {
    selectedLayer.innerHTML = '';
    selected.forEach(function (_sel, el) {
      if (!el.isConnected) return;
      var r = el.getBoundingClientRect();
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border:2px solid ' + ACCENT + ';box-sizing:border-box;pointer-events:none;';
      selectedLayer.appendChild(box);
    });
  }

  function positionHover(el) {
    var r = el.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = r.x + 'px';
    hoverBox.style.top = r.y + 'px';
    hoverBox.style.width = r.width + 'px';
    hoverBox.style.height = r.height + 'px';
    labelEl.style.display = 'block';
    labelEl.style.left = r.x + 'px';
    labelEl.style.top = Math.max(0, r.y - 20) + 'px';
  }

  function onMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOverlay(el)) {
      hoverBox.style.display = 'none';
      labelEl.style.display = 'none';
      hovered = null;
      return;
    }
    if (el === hovered) {
      positionHover(el);
      return;
    }
    hovered = el;
    var sel = __smSelectorFor(el);
    positionHover(el);
    labelEl.textContent = sel;
    events.push({ type: 'hover', selector: sel, label: labelFor(el), tag: el.tagName.toLowerCase(), rect: rectOf(el) });
  }

  function onClick(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOverlay(el)) return;
    e.preventDefault();
    e.stopPropagation();
    var sel = __smSelectorFor(el);
    var payload = { selector: sel, label: labelFor(el), tag: el.tagName.toLowerCase(), rect: rectOf(el) };
    if (e.metaKey || e.ctrlKey) {
      if (selected.has(el)) {
        selected.delete(el);
        events.push(Object.assign({ type: 'unpick' }, payload));
      } else {
        selected.set(el, sel);
        events.push(Object.assign({ type: 'pick' }, payload));
      }
    } else {
      selected.forEach(function (prevSel, prevEl) {
        if (prevEl === el) return;
        events.push({ type: 'unpick', selector: prevSel, label: labelFor(prevEl), tag: prevEl.tagName.toLowerCase(), rect: rectOf(prevEl) });
      });
      selected.clear();
      selected.set(el, sel);
      events.push(Object.assign({ type: 'pick', replace: true }, payload));
    }
    drawSelected();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      events.push({ type: 'exit' });
      teardown();
    }
  }

  function teardown() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    hoverBox.remove();
    selectedLayer.remove();
    labelEl.remove();
    delete window.__smPicker;
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  window.__smPicker = {
    drain: function () {
      var out = events;
      events = [];
      return out;
    },
    stop: teardown,
  };
})();
`;

const POLL_MS = 120;

/** @type {Map<string, { interval: NodeJS.Timeout, reinject: () => void, onDestroyed: () => void, wc: Electron.WebContents }>} */
const pickingState = new Map();

function cleanup(viewId) {
  const state = pickingState.get(viewId);
  if (!state) return;
  clearInterval(state.interval);
  try {
    state.wc.removeListener('did-finish-load', state.reinject);
    state.wc.removeListener('destroyed', state.onDestroyed);
  } catch {
    // webContents already gone
  }
  pickingState.delete(viewId);
}

const EVENT_TYPES = new Set(['hover', 'pick', 'unpick', 'exit']);
const STR_MAX = 300;

// The drained payload comes out of the embedded page's own JS context — a
// hostile or compromised site could shadow `window.__smPicker` and feed us
// arbitrary data instead of a real pick. Bound and type-check every field
// before it reaches the renderer, mirroring handleRecordEvent's treatment of
// the (similarly page-controlled) recorder event stream in browserView.cjs.
function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !EVENT_TYPES.has(raw.type)) return null;
  const ev = { type: raw.type };
  if (typeof raw.selector === 'string') ev.selector = raw.selector.slice(0, STR_MAX);
  if (typeof raw.label === 'string') ev.label = raw.label.slice(0, STR_MAX);
  if (typeof raw.tag === 'string') ev.tag = raw.tag.slice(0, 32);
  if (raw.replace === true) ev.replace = true;
  if (raw.rect && typeof raw.rect === 'object') {
    const { x, y, width, height } = raw.rect;
    if ([x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      ev.rect = { x, y, width, height };
    }
  }
  return ev;
}

async function pollOnce(viewId, wc) {
  if (wc.isDestroyed()) {
    cleanup(viewId);
    return;
  }
  let events;
  try {
    events = await wc.executeJavaScript('window.__smPicker ? window.__smPicker.drain() : null');
  } catch {
    return;
  }
  if (!Array.isArray(events) || !events.length) return;
  for (const raw of events) {
    const ev = sanitizeEvent(raw);
    if (!ev) continue;
    sendIfAlive(win, `browser:picker-event:${viewId}`, ev);
    if (ev.type === 'exit') {
      cleanup(viewId);
      return;
    }
  }
}

async function pickerStart({ viewId }, getView) {
  const view = getView(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  if (pickingState.has(viewId)) return { ok: true };
  const wc = view.webContents;
  try {
    await wc.executeJavaScript(PICKER_SCRIPT, true);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  // Page JS context is torn down on every navigation — re-inject so a
  // picking session survives the user navigating while picking.
  const reinject = () => {
    if (!pickingState.has(viewId) || wc.isDestroyed()) return;
    wc.executeJavaScript(PICKER_SCRIPT, true).catch(() => {});
  };
  wc.on('did-finish-load', reinject);
  const onDestroyed = () => cleanup(viewId);
  wc.once('destroyed', onDestroyed);
  const interval = setInterval(() => pollOnce(viewId, wc), POLL_MS);
  pickingState.set(viewId, { interval, reinject, onDestroyed, wc });
  return { ok: true };
}

async function pickerStop({ viewId }, getView) {
  const state = pickingState.get(viewId);
  cleanup(viewId);
  const view = getView(viewId);
  if (view && !view.webContents.isDestroyed()) {
    try {
      await view.webContents.executeJavaScript('window.__smPicker && window.__smPicker.stop()');
    } catch {
      // view may have navigated/closed mid-teardown — nothing further to do
    }
  }
  return { ok: true, wasPicking: Boolean(state) };
}

function registerBrowserCapture({ ipcMain, getView }) {
  const { schemas, validated } = require('./ipcSchemas.cjs');
  ipcMain.handle('browser:picker-start', validated(schemas.browserViewId, (payload) => pickerStart(payload, getView)));
  ipcMain.handle('browser:picker-stop', validated(schemas.browserViewId, (payload) => pickerStop(payload, getView)));
}

module.exports = { registerBrowserCapture, attachWindow, SELECTOR_CHAIN_SOURCE, PICKER_SCRIPT };
