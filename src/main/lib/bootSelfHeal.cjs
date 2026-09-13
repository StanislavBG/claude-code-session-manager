'use strict';

/**
 * bootSelfHeal.cjs — the epic-index self-heal scan, split out of
 * app.whenReady() so it can run off the boot critical path.
 *
 * A project whose active-index.json is MISSING or fails to parse has lost
 * every open Epic's status unless the per-Epic status mirror
 * (epicStatusMirror.cjs) can rebuild it. `allProjectCwds()` is a synchronous
 * ~270ms directory scan; looping it straight through every project inside
 * app.whenReady()'s synchronous body blocked the event loop long enough that
 * the renderer's first IPC round trips (schedule.state, billing.fetch,
 * teams.list) hit their 5s deadlines before any handler could dispatch.
 *
 * `scheduleBootSelfHeal` defers `runEpicIndexSelfHeal` until the main window
 * has painted (`did-finish-load`), with an unconditional `setImmediate`
 * fallback for the window-destroyed-before-load and no-window (headless)
 * cases, so the scan still runs exactly once per boot either way. It yields
 * to the event loop between projects so a machine with thousands of
 * projects can't stall it for a second straight.
 */

async function runEpicIndexSelfHeal(deps) {
  const { fs, allProjectCwds, promptSessionsActiveIndexPath, rebuildActiveIndex, logs } = deps;
  try {
    for (const projectCwd of allProjectCwds()) {
      const indexPath = promptSessionsActiveIndexPath(projectCwd);
      let unclean = false;
      let parseError = null;
      if (!fs.existsSync(indexPath)) {
        unclean = true;
      } else {
        try {
          JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        } catch (e) {
          unclean = true;
          parseError = e.message;
        }
      }
      if (unclean) {
        try {
          const { rows, skipped } = rebuildActiveIndex(projectCwd);
          logs.writeLine({
            scope: 'active-index-rebuild',
            level: 'info',
            message: 'rebuilt active-index.json from status mirrors',
            meta: { cwd: projectCwd, parseError, restored: rows.length, skipped: skipped.length },
          });
        } catch (e) {
          logs.writeLine({ scope: 'active-index-rebuild', level: 'error', message: 'rebuild failed', meta: { cwd: projectCwd, error: e?.message } });
        }
      }
      // Yield between projects so a multi-thousand-project machine can't
      // stall the event loop for a second at a time.
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  } catch (e) {
    logs.writeLine({ scope: 'active-index-rebuild', level: 'error', message: 'boot sweep failed', meta: { error: e?.message } });
  }
}

function scheduleBootSelfHeal(mainWindow, deps) {
  let ran = false;
  const runOnce = () => {
    if (ran) return;
    ran = true;
    runEpicIndexSelfHeal(deps);
  };

  const webContents = mainWindow && typeof mainWindow.isDestroyed === 'function' && !mainWindow.isDestroyed()
    ? mainWindow.webContents
    : null;

  if (webContents && !webContents.isDestroyed()) {
    webContents.once('did-finish-load', runOnce);
    // Edge case: the window can be destroyed before it ever finishes
    // loading (closed during boot, crashed renderer). did-finish-load would
    // then never fire and the self-heal would silently never run — fall
    // back to an unconditional setImmediate so it still runs exactly once.
    webContents.once('destroyed', () => setImmediate(runOnce));
  } else {
    // Headless / no-visible-window boot — nothing will ever emit
    // did-finish-load, so run on the very next event-loop turn instead.
    setImmediate(runOnce);
  }
}

module.exports = { scheduleBootSelfHeal, runEpicIndexSelfHeal };
