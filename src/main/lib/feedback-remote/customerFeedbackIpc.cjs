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
 * The one submit path for the panel IPC and the admin route: prepares any
 * attached images (renderer data URLs and/or absolute file paths) once via
 * feedbackImages.prepareFeedbackImages, then calls client.submit. A prepare
 * error resolves { ok: false, error } without submitting; otherwise the
 * client's result (including any `warning`) is returned unchanged.
 * @param {{ title: string, body: string, tag: string, images?: { dataUrl: string }[], imagePaths?: string[], context?: unknown }} p
 * @param {any} [client]
 * @param {(inputs: { dataUrl?: string, path?: string }[]) => Promise<any>} [prepare]
 */
async function submitFeedback(p, client = getClient(), prepare = require('./feedbackImages.cjs').prepareFeedbackImages) {
  const inputs = [
    ...(p.images || []).map((i) => ({ dataUrl: i.dataUrl })),
    ...(p.imagePaths || []).map((x) => ({ path: x })),
  ];
  const prepared = await prepare(inputs);
  if (!prepared || !prepared.ok) {
    return { ok: false, error: prepared && typeof prepared.error === 'string' ? prepared.error : 'Images could not be prepared.' };
  }
  return client.submit({
    title: p.title, body: p.body, tag: p.tag, images: prepared.images,
    ...(p.context !== undefined && p.context !== null ? { context: p.context } : {}),
  });
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
  // Returns the cached image's data URL to the renderer only — never log it.
  ipcMain.handle('customerFeedback:inbox-image', v(s.customerFeedbackInboxImage, ({ id, index }) => inbox.readCachedImage(id, index)));

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
