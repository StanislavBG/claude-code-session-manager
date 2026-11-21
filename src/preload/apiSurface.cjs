/**
 * apiSurface.cjs — single source of truth for the renderer↔main `window.api`
 * surface: one row per method exposed by preload/index.cjs.
 *
 * kind:   invoke | send | on | on-dynamic (per-tab channel; `*` = the tabId suffix)
 * remote: policy when the surface is tunnelled to a remote browser
 *   read   — never writes state, spawns processes, or touches OS UI
 *   mutate — everything else that is allowed remotely
 *   deny   — desktop-only (pty, clipboard, shell, updater, config fs access, …)
 * pack:   (invoke/send only, optional) preload packs the positional params into ONE
 *         object arg: `["path","base64"]` = `{ path, base64 }` in positional order. A
 *         `"...name"` entry spreads that (object) positional arg into the packed object
 *         instead of naming a key. Absent = args are forwarded positionally. Browser
 *         stand-in (renderer/web/remoteApi.ts) uses it to post the same shape preload would.
 *         Rows preload transforms in other ways (voice.setTtsEnabled `!!`, memory.ask /
 *         memory.proposeFix nested target) are pinned as KNOWN_UNDESCRIBED in the test.
 * Classification is conservative: when unsure, mutate; screen/clipboard/fs/shell => deny.
 *
 * Drift is caught by __tests__/apiSurface.test.cjs, which replays the real preload.
 */

'use strict';

const ROWS = require('./apiSurface.json');

module.exports = Object.freeze(ROWS.map((r) => Object.freeze({ ...r })));
