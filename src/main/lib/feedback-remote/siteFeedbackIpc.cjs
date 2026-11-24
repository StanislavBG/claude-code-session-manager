// @ts-check
'use strict';

/**
 * Renderer-facing IPC for website-feedback widgets and their decrypted inbox. Every channel
 * validates its payload with a strict schema from ipcSchemas.cjs (a malformed payload throws,
 * so Electron rejects the invoke) and delegates to siteFeedbackService — the one
 * implementation shared with the Feedback MCP admin routes. Results come back unchanged
 * except that secret-named fields are stripped, so no channel can ever hand the renderer a
 * box private key or the paired device token even if a lower layer starts returning one.
 */

/** Field names that must never cross the bridge. Matched case-insensitively. */
const SECRET_KEYS = new Set(['privatekeyjwk', 'privatekey', 'devicetoken', 'token', 'secret']);

/**
 * Deep copy of `value` without any secret-named field.
 * @param {unknown} value
 * @returns {any}
 */
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * @param {{ ipcMain?: any, service?: any }} [deps]
 */
function registerSiteFeedbackHandlers(deps = {}) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');
  const service = deps.service || require('./siteFeedbackService.cjs');

  /**
   * @param {string} channel
   * @param {import('zod').ZodTypeAny} schema
   * @param {(p: any) => Promise<unknown>} call
   */
  const handle = (channel, schema, call) => {
    ipcMain.handle(channel, v(schema, async (/** @type {any} */ p) => redactSecrets(await call(p))));
  };

  handle('siteFeedback:widget-create', s.siteFeedbackWidgetCreate, (p) => service.createWidget(p));
  handle('siteFeedback:widget-list', s.siteFeedbackWidgetList, (p) => service.listWidgets(p));
  handle('siteFeedback:widget-update', s.siteFeedbackWidgetUpdate, (p) => service.updateWidget(p));
  handle('siteFeedback:widget-delete', s.siteFeedbackWidgetBox, (p) => service.deleteWidget(p));
  handle('siteFeedback:widget-snippet', s.siteFeedbackWidgetBox, (p) => service.getSnippet(p));
  handle('siteFeedback:inbox-list', s.siteFeedbackInboxList, (p) => service.listItems(p));
  handle('siteFeedback:inbox-get', s.siteFeedbackInboxGet, (p) => service.getItem(p));
  // Returns a PNG data URL to the renderer only — never log it.
  handle('siteFeedback:inbox-image', s.siteFeedbackInboxImage, (p) => service.getImage(p));
  handle('siteFeedback:inbox-set-status', s.siteFeedbackInboxSetStatus, (p) => service.setStatus(p));
  handle('siteFeedback:inbox-link-epic', s.siteFeedbackInboxLinkEpic, (p) => service.linkEpic(p));
  handle('siteFeedback:drain-now', s.siteFeedbackDrainNow, () => service.drainNow());
}

module.exports = { registerSiteFeedbackHandlers, redactSecrets, SECRET_KEYS };
