/**
 * apiSurface.cjs — single source of truth for the renderer↔main `window.api`
 * surface: one row per method exposed by preload/index.cjs.
 *
 * kind:   invoke | send | on | on-dynamic (per-tab channel; `*` = the tabId suffix)
 * remote: policy when the surface is tunnelled to a remote browser
 *   read   — never writes state, spawns processes, or touches OS UI
 *   mutate — everything else that is allowed remotely
 *   deny   — desktop-only (pty, clipboard, shell, updater, config fs access, …)
 * Classification is conservative: when unsure, mutate; screen/clipboard/fs/shell => deny.
 *
 * Drift is caught by __tests__/apiSurface.test.cjs, which replays the real preload.
 */

'use strict';

const ROWS = require('./apiSurface.json');

module.exports = Object.freeze(ROWS.map((r) => Object.freeze({ ...r })));
