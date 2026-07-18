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

// ── Capture: filter -> prune -> summarize -> chunk (PRD 404) ──────────
//
// The four capture modes ('html' | 'a11y' | 'selector' | 'agent') share one
// shape: an unprivileged executeJavaScript pass serializes the selected
// subtree (or queries outerHTML / resolves a CDP node) into a plain JSON
// value, and everything downstream of that is pure and unit-testable
// without a live page — see tests/unit/browserCapture.spec.ts.

const NOISE_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'template', 'link', 'meta']);
const KEEP_ATTRS = new Set(['role', 'name', 'data-testid', 'href', 'type', 'value', 'placeholder']);

function isHiddenNode(node) {
  const style = node.style || {};
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  const attrs = node.attrs || {};
  if ('hidden' in attrs) return true;
  if (attrs['aria-hidden'] === 'true') return true;
  return false;
}

function pruneAttrs(attrs) {
  const out = {};
  for (const key of Object.keys(attrs || {})) {
    if (KEEP_ATTRS.has(key) || key.startsWith('aria-')) out[key] = attrs[key];
  }
  return out;
}

// filter: drop noise/hidden nodes, keep interactive + semantic elements and
// non-empty text. O(n) over the subtree, n = node count in the selection.
function filterTree(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'text') {
    const text = (node.text || '').trim();
    return text ? { type: 'text', text } : null;
  }
  const tag = (node.tag || '').toLowerCase();
  if (NOISE_TAGS.has(tag)) return null;
  if (isHiddenNode(node)) return null;
  const children = (node.children || []).map(filterTree).filter(Boolean);
  return { tag, attrs: pruneAttrs(node.attrs), children };
}

function textContent(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return (node.children || []).map(textContent).join('').trim();
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LANDMARK_ROLE_BY_TAG = { header: 'banner', footer: 'contentinfo', nav: 'navigation', main: 'main', section: 'region', article: 'article', aside: 'complementary', form: 'form' };

// summarize: flatten the filtered/pruned tree into compact pseudo-markup
// grouped by landmark/role, matching docs/design/browser-tab.design.jsx's
// CaptureOutput `agent` sample. O(n) over the (already filtered) subtree.
function summarizeTree(node, depth = 0) {
  if (!node || node.type === 'text') return '';
  const pad = '  '.repeat(depth);
  const tag = node.tag;
  const attrs = node.attrs || {};

  if (HEADING_TAGS.has(tag)) {
    return `${pad}<heading level=${tag.slice(1)}>${textContent(node)}</heading>`;
  }
  if (tag === 'button' || tag === 'a') {
    const name = attrs.name || textContent(node);
    const parts = [`name="${name}"`];
    if (attrs['data-testid']) parts.push(`data-testid="${attrs['data-testid']}"`);
    if (tag === 'a' && attrs.href) parts.push(`href="${attrs.href}"`);
    const el = tag === 'a' ? 'link' : 'button';
    return `${pad}<${el} ${parts.join(' ')}>${textContent(node)}</${el}>`;
  }
  if (tag === 'ul' || tag === 'ol') {
    const items = (node.children || []).map((c) => summarizeTree(c, depth + 1)).filter(Boolean).join('\n');
    return `${pad}<list>\n${items}\n${pad}</list>`;
  }
  if (tag === 'li') {
    return `${pad}<item>${textContent(node)}</item>`;
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const parts = [];
    if (attrs.type) parts.push(`type="${attrs.type}"`);
    if (attrs.placeholder) parts.push(`placeholder="${attrs.placeholder}"`);
    if (attrs.value) parts.push(`value="${attrs.value}"`);
    if (attrs['data-testid']) parts.push(`data-testid="${attrs['data-testid']}"`);
    const attrStr = parts.length ? ' ' + parts.join(' ') : '';
    return `${pad}<field${attrStr}/>`;
  }

  const role = attrs.role || LANDMARK_ROLE_BY_TAG[tag];
  const children = node.children || [];
  const childText = children.map((c) => summarizeTree(c, depth + 1)).filter(Boolean).join('\n');
  if (role) {
    const label = attrs['aria-label'];
    const openAttr = label ? ` aria-label="${label}"` : '';
    if (!childText) return '';
    return `${pad}<region${openAttr}>\n${childText}\n${pad}</region>`;
  }
  // Plain wrapper (div/span/p/etc): if it's a single-text leaf, emit <text>;
  // otherwise splice children in at this depth without adding a wrapper tag.
  if (children.length === 1 && children[0].type === 'text') {
    return `${pad}<text>${children[0].text}</text>`;
  }
  return childText;
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// chunk: split on line boundaries so a chunk never exceeds budgetBytes.
// O(n) over the text, n = byte length.
function chunkText(text, budgetBytes) {
  if (Buffer.byteLength(text, 'utf8') <= budgetBytes) return [text];
  const lines = text.split(/(?<=\n)/);
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && Buffer.byteLength(current + line, 'utf8') > budgetBytes) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const DEFAULT_CHUNK_BUDGET_BYTES = 8192;

function buildAgentCapture(rawTree, budgetBytes = DEFAULT_CHUNK_BUDGET_BYTES) {
  const filtered = filterTree(rawTree);
  const summary = filtered ? summarizeTree(filtered) : '';
  const chunks = chunkText(summary, budgetBytes);
  const text = chunks[0] || '';
  return { text, meta: { chunks: chunks.length, tokens: estimateTokens(text) } };
}

function formatHtmlCapture(nodes) {
  return nodes
    .map((n, i) => `<!-- node ${i + 1}: ${n.selector} -->\n${n.outerHTML}`)
    .join('\n\n');
}

// selector: reuse the SELECTOR_CHAIN_SOURCE precedence (testId > id > role+name
// > css > xpath) to pick the preferred entry among the fallback chain.
function formatSelectorChain({ css, xpath, role, name, id, testId } = {}) {
  const lines = [];
  if (css) lines.push({ key: 'css', text: `css    ${css}` });
  if (xpath) lines.push({ key: 'xpath', text: `xpath  ${xpath}` });
  if (role && name) lines.push({ key: 'aria', text: `aria   role=${role} name="${name}"` });
  if (testId) lines.push({ key: 'test', text: `test   [data-testid="${testId}"]` });

  const precedence = testId ? 'test' : id ? 'css' : role && name ? 'aria' : css ? 'css' : 'xpath';
  return lines
    .map((l) => (l.key === precedence ? `${l.text}   ← preferred` : l.text))
    .join('\n');
}

// a11y: format a normalized CDP AX-tree node (role/name/level/states/testId
// + children) as the indented tree in CaptureOutput's `a11y` sample.
function formatA11yTree(node, depth = 0) {
  if (!node) return '';
  const pad = '  '.repeat(depth);
  const head = node.name ? `${pad}${node.role}  "${node.name}"` : `${pad}${node.role}`;
  const extras = [];
  if (typeof node.level === 'number') extras.push(`level ${node.level}`);
  for (const state of node.states || []) extras.push(state);
  const lines = [extras.length ? `${head}           ${extras.join(' ')}` : head];
  if (node.testId) lines.push(`${pad}           data-testid=${node.testId}`);
  for (const child of node.children || []) {
    const childText = formatA11yTree(child, depth + 1);
    if (childText) lines.push(childText);
  }
  return lines.join('\n');
}

// ── CDP accessibility-tree capture ─────────────────────────────────────
async function captureA11y(wc, selector) {
  const dbg = wc.debugger;
  await dbg.attach('1.3');
  try {
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('Accessibility.enable');
    const { root } = await dbg.sendCommand('DOM.getDocument');
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { nodes } = await dbg.sendCommand('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: true });
    return axNodesToTree(nodes);
  } finally {
    try {
      await dbg.sendCommand('Accessibility.disable');
      await dbg.sendCommand('DOM.disable');
    } catch {
      // best-effort; detach regardless
    }
    try {
      dbg.detach();
    } catch {
      // already detached
    }
  }
}

function axPropValue(ax, name) {
  const prop = (ax.properties || []).find((p) => p.name === name);
  return prop ? prop.value.value : undefined;
}

// Accessibility.getPartialAXTree returns a flat array (root first, then
// relatives referenced by childIds) — rebuild the nested shape formatA11yTree
// expects. O(n) over the returned node count.
// AX node names/roles can carry attacker-influenced content (aria-label);
// bound string length, and cap total nodes visited to guard against a
// malformed/cyclic childIds graph causing unbounded recursion.
const AX_NODE_VISIT_CAP = 2_000;
const AX_STRING_CAP = 1_000;

function axNodesToTree(axNodes) {
  if (!Array.isArray(axNodes) || !axNodes.length) return null;
  const byId = new Map(axNodes.map((n) => [n.nodeId, n]));
  const visited = new Set();
  let count = 0;
  function build(ax) {
    if (!ax || visited.has(ax.nodeId) || count >= AX_NODE_VISIT_CAP) return null;
    visited.add(ax.nodeId);
    count += 1;
    const states = [];
    if (axPropValue(ax, 'focusable')) states.push('focusable');
    if (axPropValue(ax, 'checked')) states.push('checked');
    if (axPropValue(ax, 'expanded')) states.push('expanded');
    if (axPropValue(ax, 'disabled')) states.push('disabled');
    const children = (ax.childIds || []).map((id) => build(byId.get(id))).filter(Boolean);
    return {
      role: capString(ax.role && ax.role.value, AX_STRING_CAP),
      name: capString(ax.name && ax.name.value, AX_STRING_CAP),
      level: axPropValue(ax, 'level'),
      states,
      children,
    };
  }
  return build(axNodes[0]);
}

// Everything below comes back from executeJavaScript running inside the
// embedded (possibly untrusted third-party) page — same threat model as
// sanitizeEvent above: a compromised page could return an oversized or
// malformed payload instead of real capture data. Bound every string field
// before it reaches formatting/IPC.
const CAPTURE_HTML_CAP = 200_000;
const CAPTURE_FIELD_CAP = 4_000;
const CAPTURE_TEXT_CAP = 20_000;
const CAPTURE_NODE_CAP = 5_000;

function capString(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : s;
}

function capRawTree(node, budget = { count: 0 }) {
  if (!node || typeof node !== 'object' || budget.count >= CAPTURE_NODE_CAP) return null;
  budget.count += 1;
  if (node.type === 'text') return { type: 'text', text: capString(node.text, CAPTURE_TEXT_CAP) };
  const attrs = {};
  for (const key of Object.keys(node.attrs || {})) {
    attrs[capString(key, 256)] = capString(node.attrs[key], CAPTURE_FIELD_CAP);
  }
  const children = (node.children || [])
    .map((c) => capRawTree(c, budget))
    .filter(Boolean);
  return { tag: capString(node.tag, 64), attrs, style: node.style, children };
}

// ── Top-level capture dispatch ─────────────────────────────────────────
async function captureSelection({ viewId, selectors, mode }, getView) {
  const view = getView(viewId);
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'unknown viewId' };
  const wc = view.webContents;

  if (mode === 'html') {
    const nodes = await wc.executeJavaScript(
      `(function () {
        ${SELECTOR_CHAIN_SOURCE}
        return (${JSON.stringify(selectors)}).map(function (sel) {
          var el = document.querySelector(sel);
          return el ? { selector: sel, outerHTML: el.outerHTML } : null;
        }).filter(Boolean);
      })()`,
    );
    const capped = (Array.isArray(nodes) ? nodes : []).slice(0, selectors.length).map((n) => ({
      selector: capString(n && n.selector, CAPTURE_FIELD_CAP),
      outerHTML: capString(n && n.outerHTML, CAPTURE_HTML_CAP),
    }));
    const text = formatHtmlCapture(capped);
    return { ok: true, mode, text, meta: {} };
  }

  if (mode === 'selector') {
    const infos = await wc.executeJavaScript(
      `(function () {
        ${SELECTOR_CHAIN_SOURCE}
        return (${JSON.stringify(selectors)}).map(function (sel) {
          var el = document.querySelector(sel);
          if (!el) return null;
          return {
            css: __smCssPath(el) || sel,
            xpath: __smXPath(el),
            role: el.getAttribute('role') || undefined,
            name: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 60) || undefined,
            id: el.id || undefined,
            testId: el.getAttribute('data-testid') || undefined,
          };
        }).filter(Boolean);
      })()`,
    );
    const capped = (Array.isArray(infos) ? infos : []).slice(0, selectors.length).map((info) => ({
      css: capString(info && info.css, CAPTURE_FIELD_CAP),
      xpath: capString(info && info.xpath, CAPTURE_FIELD_CAP),
      role: capString(info && info.role, 256),
      name: capString(info && info.name, 256),
      id: capString(info && info.id, 256),
      testId: capString(info && info.testId, 256),
    }));
    const text = capped.map(formatSelectorChain).join('\n\n');
    return { ok: true, mode, text, meta: {} };
  }

  if (mode === 'a11y') {
    // captureA11y attaches/detaches the CDP debugger per call, so loop
    // sequentially rather than firing selectors in parallel (mirrors the
    // multi-select behavior of the html/selector modes above, which apply to
    // the whole `selectors` array instead of only the first entry).
    const trees = [];
    for (const selector of selectors) {
      const tree = await captureA11y(wc, selector);
      if (tree) trees.push(tree);
    }
    const text = trees.map((t) => formatA11yTree(t)).join('\n\n');
    return { ok: true, mode, text, meta: {} };
  }

  // mode === 'agent'
  const rawTrees = await wc.executeJavaScript(
    `(function () {
      function serialize(el) {
        if (el.nodeType === 3) {
          var t = el.textContent || '';
          return t.trim() ? { type: 'text', text: t } : null;
        }
        if (el.nodeType !== 1) return null;
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        var cs = window.getComputedStyle(el);
        var children = [];
        for (var j = 0; j < el.childNodes.length; j++) {
          var c = serialize(el.childNodes[j]);
          if (c) children.push(c);
        }
        return { tag: el.tagName.toLowerCase(), attrs: attrs, style: { display: cs.display, visibility: cs.visibility }, children: children };
      }
      return (${JSON.stringify(selectors)}).map(function (sel) {
        var el = document.querySelector(sel);
        return el ? serialize(el) : null;
      }).filter(Boolean);
    })()`,
  );
  const parts = (Array.isArray(rawTrees) ? rawTrees : []).map((t) => buildAgentCapture(capRawTree(t)));
  const text = parts.map((p) => p.text).join('\n\n');
  const meta = {
    chunks: parts.reduce((a, p) => a + (p.meta.chunks || 0), 0),
    tokens: parts.reduce((a, p) => a + (p.meta.tokens || 0), 0),
  };
  return { ok: true, mode, text, meta };
}

function registerBrowserCapture({ ipcMain, getView }) {
  const { schemas, validated } = require('./ipcSchemas.cjs');
  ipcMain.handle('browser:picker-start', validated(schemas.browserViewId, (payload) => pickerStart(payload, getView)));
  ipcMain.handle('browser:picker-stop', validated(schemas.browserViewId, (payload) => pickerStop(payload, getView)));
  ipcMain.handle('browser:capture', validated(schemas.browserCaptureSelection, (payload) => captureSelection(payload, getView)));
}

module.exports = {
  registerBrowserCapture,
  attachWindow,
  SELECTOR_CHAIN_SOURCE,
  PICKER_SCRIPT,
  filterTree,
  summarizeTree,
  chunkText,
  estimateTokens,
  buildAgentCapture,
  formatHtmlCapture,
  formatSelectorChain,
  formatA11yTree,
};
