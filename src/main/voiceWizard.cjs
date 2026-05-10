/**
 * voiceWizard — F7 first-run mic-check wizard, main-process side.
 *
 * Owns three IPC channels:
 *   - voice:wizard-state   → returns persisted state + current schema constant
 *   - voice:wizard-complete → stamps completedAt + completedSchema to voice.json
 *   - app:is-e2e           → exposes process.env.SM_E2E === '1' to the renderer
 *
 * No window state held here; persistence is delegated to voiceSettings.cjs
 * (additive `wizard` subtree on the same file as F1/F5).
 */

const { ipcMain } = require('electron');
const voiceSettings = require('./voiceSettings.cjs');

function registerWizardHandlers() {
  ipcMain.handle('voice:wizard-state', async () => {
    const w = await voiceSettings.loadWizard();
    return {
      completedSchema: w.completedSchema,
      completedAt: w.completedAt,
      currentSchema: voiceSettings.WIZARD_SCHEMA,
    };
  });

  ipcMain.handle('voice:wizard-complete', async () => {
    const next = {
      completedSchema: voiceSettings.WIZARD_SCHEMA,
      completedAt: new Date().toISOString(),
    };
    await voiceSettings.saveWizard(next);
    return { ok: true, ...next, currentSchema: voiceSettings.WIZARD_SCHEMA };
  });

  // E2E plumbing: tests set SM_E2E=1 to suppress the wizard auto-trigger.
  // The renderer reads this once on mount.
  ipcMain.handle('app:is-e2e', () => process.env.SM_E2E === '1');

  // F8 — turn-detector settings (additive subtree on voice.json).
  // MVP: persistence only; no model loaded in v1 (see PRD §Loading & inference).
  ipcMain.handle('voice:get-turn-detector', async () => {
    return await voiceSettings.loadTurnDetector();
  });

  ipcMain.handle('voice:set-turn-detector', async (_e, state) => {
    if (!voiceSettings.isValidTurnDetectorState(state)) {
      throw new Error('Invalid turn-detector state payload');
    }
    await voiceSettings.saveTurnDetector(state);
    return { ok: true, state: await voiceSettings.loadTurnDetector() };
  });
}

module.exports = { registerWizardHandlers };
