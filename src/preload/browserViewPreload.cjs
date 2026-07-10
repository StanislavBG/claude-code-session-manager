/**
 * Preload for embedded Browser-tab WebContentsViews (PRD 408 recorder
 * engine). Exposes a minimal `window.__smRecorder.setRecording(bool)` toggle
 * via contextBridge so the main process can arm/disarm step capture without
 * ever giving page script node/ipcRenderer access. Typed values are never
 * captured — only the target selector + a `masked` flag — per the tab's
 * "sandboxed · no filesystem · no passwords" guardrail.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Secret handed to us via `additionalArguments` (never touches the DOM or a
// script tag the embedded page could inspect) — required on every toggle so
// the page itself can't call the exposeInMainWorld bridge to interfere with
// a recording session it has no business controlling.
const TOKEN_PREFIX = '--sm-record-token=';
const expectedToken = (process.argv.find((a) => a.startsWith(TOKEN_PREFIX)) || '').slice(TOKEN_PREFIX.length) || null;

let capturing = false;

function selectorFor(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `#${el.id}`;
  const testId = typeof el.getAttribute === 'function' ? el.getAttribute('data-testid') : null;
  if (testId) return `[data-testid="${testId}"]`;
  const tag = el.tagName.toLowerCase();
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return cls ? `${tag}.${cls}` : tag;
}

function variableSuggestionFor(el) {
  const name = String(el.name || el.id || '').toLowerCase();
  if (el.type === 'password' || /pass/.test(name)) return 'password';
  if (/email/.test(name)) return 'email';
  if (/user/.test(name)) return 'username';
  return name || 'value';
}

document.addEventListener(
  'click',
  (e) => {
    if (!capturing) return;
    ipcRenderer.send('browser:record-event', { verb: 'click', target: selectorFor(e.target) });
  },
  true,
);

document.addEventListener(
  'change',
  (e) => {
    if (!capturing) return;
    const el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
    ipcRenderer.send('browser:record-event', {
      verb: 'type',
      target: selectorFor(el),
      variableSuggestion: variableSuggestionFor(el),
    });
  },
  true,
);

contextBridge.exposeInMainWorld('__smRecorder', {
  setRecording: (v, token) => {
    if (!expectedToken || token !== expectedToken) return;
    capturing = !!v;
  },
});
