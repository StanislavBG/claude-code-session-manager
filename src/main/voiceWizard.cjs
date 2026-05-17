/**
 * voiceWizard — F7 first-run mic-check wizard, main-process side.
 *
 * Owns:
 *   - voice:wizard-state   → returns persisted state + current schema constant
 *   - voice:wizard-complete → stamps completedAt + completedSchema to voice.json
 *
 * No window state held here; persistence is delegated to voiceSettings.cjs
 * (additive `wizard` subtree on the same file as F1/F5).
 */

const { ipcMain } = require('electron');
const voiceSettings = require('./voiceSettings.cjs');
const { schemas, validated } = require('./ipcSchemas.cjs');

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

  // F8 — turn-detector settings (additive subtree on voice.json).
  // MVP: persistence only; no model loaded in v1 (see PRD §Loading & inference).
  ipcMain.handle('voice:get-turn-detector', async () => {
    return await voiceSettings.loadTurnDetector();
  });

  ipcMain.handle('voice:set-turn-detector', validated(schemas.voiceSetTurnDetector, async (state) => {
    await voiceSettings.saveTurnDetector(state);
    return { ok: true, state: await voiceSettings.loadTurnDetector() };
  }));
}

module.exports = { registerWizardHandlers };
