/**
 * voiceWizard — F7 first-run mic-check wizard + F8 turn-detector, main side.
 *
 * Exports plain functions only. The `voice:*` ipcMain handlers for all of
 * these are registered in ONE place: voiceHotkey.registerHotkeyHandlers().
 * Persistence is delegated to voiceSettings.cjs (additive subtrees on voice.json).
 */

const voiceSettings = require('./voiceSettings.cjs');

async function wizardState() {
  const w = await voiceSettings.loadWizard();
  return {
    completedSchema: w.completedSchema,
    completedAt: w.completedAt,
    currentSchema: voiceSettings.WIZARD_SCHEMA,
  };
}

async function wizardComplete() {
  const next = {
    completedSchema: voiceSettings.WIZARD_SCHEMA,
    completedAt: new Date().toISOString(),
  };
  await voiceSettings.saveWizard(next);
  return { ok: true, ...next, currentSchema: voiceSettings.WIZARD_SCHEMA };
}

async function getTurnDetector() {
  return await voiceSettings.loadTurnDetector();
}

async function setTurnDetector(state) {
  await voiceSettings.saveTurnDetector(state);
  return { ok: true, state: await voiceSettings.loadTurnDetector() };
}

module.exports = { wizardState, wizardComplete, getTurnDetector, setTurnDetector };
