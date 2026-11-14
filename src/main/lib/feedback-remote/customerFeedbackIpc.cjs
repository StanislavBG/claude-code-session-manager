// @ts-check
'use strict';

const REFRESH_DELAY_MS = 30_000;

/**
 * The configured customer-feedback client the panel's customerFeedback:submit
 * uses. The admin submit route (customerFeedbackAdminRoutes.cjs) reaches the
 * client through this same getter so an agent submission writes the same
 * mirror + receipt as a panel one.
 */
function getClient() {
  return require('./customerFeedbackClient.cjs');
}

/**
 * Exactly the panel's submit call. @param {{ title: string, body: string, tag: string }} p
 * @param {any} [client]
 */
function submitFeedback(p, client = getClient()) {
  return client.submit(p);
}

/**
 * Renderer-facing IPC for the customer-feedback client + owner inbox.
 * Handlers return the libs' `{ ok, ... }` results unchanged.
 * @param {{ ipcMain?: any, client?: any, inbox?: any, setTimeoutImpl?: typeof setTimeout }} [deps]
 */
function registerCustomerFeedbackHandlers(deps = {}) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');
  const client = deps.client || getClient();
  const inbox = deps.inbox || require('./customerFeedbackInbox.cjs');
  const timer = deps.setTimeoutImpl || setTimeout;

  ipcMain.handle('customerFeedback:submit', v(s.customerFeedbackSubmit, (p) => submitFeedback(p, client)));
  ipcMain.handle('customerFeedback:list', () => client.list());
  ipcMain.handle('customerFeedback:refresh-status', () => client.refreshStatuses());
  ipcMain.handle('customerFeedback:mark-seen', v(s.customerFeedbackMarkSeen, ({ ids }) => client.markSeen(ids)));
  ipcMain.handle('customerFeedback:owner-info', () => inbox.getOwnerInfo());
  ipcMain.handle('customerFeedback:inbox-pull', () => inbox.pull());
  ipcMain.handle('customerFeedback:inbox-list', v(s.customerFeedbackInboxList, ({ includeHidden }) => inbox.list({ includeHidden })));
  ipcMain.handle('customerFeedback:inbox-set-status', v(s.customerFeedbackInboxSetStatus, ({ id, status, note }) => inbox.setStatus(id, status, note)));
  ipcMain.handle('customerFeedback:inbox-link-epic', v(s.customerFeedbackInboxLinkEpic, ({ id, epicId }) => inbox.linkEpic(id, epicId)));

  // One-shot deferred refresh so users see resolutions without opening anything.
  try {
    const t = timer(() => {
      Promise.resolve()
        .then(() => client.refreshStatuses())
        .catch((/** @type {any} */ e) => {
          console.warn('[customerFeedback] boot status refresh failed:', e && e.name ? e.name : 'error');
        });
    }, REFRESH_DELAY_MS);
    if (t && typeof t.unref === 'function') t.unref();
  } catch {
    /* never throw at boot */
  }
}

module.exports = { registerCustomerFeedbackHandlers, getClient, submitFeedback, REFRESH_DELAY_MS };
