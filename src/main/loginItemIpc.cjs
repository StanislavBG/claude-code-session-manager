'use strict';

/**
 * loginItemIpc.cjs — registers the `loginItem:*` IPC handlers over a login-item module built by
 * lib/process/loginItem.cjs (createLoginItem). Local renderer only; no remote/relay command reaches it.
 *   loginItem:status       → the module's status()
 *   loginItem:set-enabled  { enabled: boolean } → { ok: true, status } | { ok: false, error }
 */

const { z } = require('zod');

const schemas = {
  setEnabled: z.object({ enabled: z.boolean() }).strict(),
};

/**
 * @param {{ ipcMain: any, loginItem: { status: () => any, setEnabled: (on: boolean) => Promise<any> } }} opts
 */
function registerLoginItemIpc({ ipcMain, loginItem }) {
  ipcMain.handle('loginItem:status', () => loginItem.status());
  ipcMain.handle('loginItem:set-enabled', async (_event, payload) => {
    const parsed = schemas.setEnabled.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: `Invalid payload: ${parsed.error.issues.map((i) => i.message).join('; ') || 'expected { enabled: boolean }'}` };
    }
    try {
      const status = await loginItem.setEnabled(parsed.data.enabled);
      return { ok: true, status };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
}

module.exports = { registerLoginItemIpc };
