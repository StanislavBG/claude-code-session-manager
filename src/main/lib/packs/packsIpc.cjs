'use strict';

/**
 * packsIpc.cjs — `packs:list`: the shipped context-pack catalog as DISPLAY data
 * for the New Session picker. Returns only { id, label, description, requires,
 * hasLaws } per pack — never the pack dir, plugin name, or laws text, which stay
 * main-side (spawn args are built in packSpawnArgs.cjs). Catalog load errors are
 * dropped here because they carry absolute paths.
 */

function toDisplay(p) {
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    requires: p.requires && typeof p.requires === 'object' ? { ...p.requires } : {},
    hasLaws: typeof p.laws === 'string' && p.laws.length > 0,
  };
}

/**
 * @param {{ ipcMain?: any, listPacks?: () => { packs: any[] } }} [opts]
 */
function registerPacksHandlers(opts = {}) {
  const ipcMain = opts.ipcMain || require('electron').ipcMain;
  const listPacks = opts.listPacks || require('./packCatalog.cjs').listPacks;
  ipcMain.handle('packs:list', async () => {
    try {
      const res = listPacks();
      const packs = (res && Array.isArray(res.packs) ? res.packs : []).map(toDisplay);
      return { ok: true, packs };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

module.exports = { registerPacksHandlers };
