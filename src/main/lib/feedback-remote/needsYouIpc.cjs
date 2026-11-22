// @ts-check
'use strict';

/**
 * needsYouIpc.cjs — renderer-facing IPC for the Dashboard's "Needs you" list,
 * over needsYouStore.cjs:
 *   needsYou:list   (no payload)          -> { ok: true, items }   (open items only)
 *   needsYou:answer { app, id, answer }   -> { ok: true, item } | { ok: false, error }
 *
 * A successful answer appends one `needs_you_answered` audit row (app, id,
 * answer, and the item's externalRef when it has one) so the outside app that
 * posted the item can read the decision, then calls onChanged once. When the
 * store refuses (no open item, or the answer is not one of its options) the
 * handler returns an error in words and writes nothing.
 */

const needsYouStore = require('./needsYouStore.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');

/**
 * @param {{ ipcMain?: any, onChanged?: () => void }} [deps]
 */
function registerNeedsYouIpc(deps = {}) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const { onChanged } = deps;
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');

  ipcMain.handle('needsYou:list', v(s.needsYouList, async () => {
    const items = await needsYouStore.listNeedsYou({ status: 'open' });
    return { ok: true, items };
  }));

  ipcMain.handle('needsYou:answer', v(s.needsYouAnswer, async ({ app, id, answer }) => {
    const item = await needsYouStore.answerNeedsYou({ app, id, answer });
    if (!item) {
      return {
        ok: false,
        error: `There is no open question "${id}" from ${app} with the option "${answer}". It may already be answered or withdrawn.`,
      };
    }
    /** @type {Record<string, unknown>} */
    const row = { app: item.app, id: item.id, answer: item.answer };
    if (item.externalRef) row.externalRef = item.externalRef;
    appendAuditEvent('needs_you_answered', row);
    if (onChanged) onChanged();
    return { ok: true, item };
  }));
}

module.exports = { registerNeedsYouIpc };
