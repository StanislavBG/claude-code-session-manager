'use strict';

/**
 * killTree.cjs — cross-platform "kill this child and its descendants" plus the
 * matching spawn options for children we intend to kill that way.
 *
 * POSIX: children are spawned `detached: true` so they lead their own process
 * group, and `process.kill(-pid, sig)` signals the whole group.
 * win32: no process groups; `taskkill /PID <pid> /T /F` kills the tree.
 */

const { execFile: nodeExecFile } = require('node:child_process');

/**
 * @typedef {object} KillTreeOpts
 * @property {string} [platform]  defaults to process.platform
 * @property {(pid: number, signal?: string | number) => unknown} [kill]  defaults to process.kill
 * @property {(file: string, args: string[], options: object, cb: (err: Error | null) => void) => unknown} [execFile]
 * @property {(msg: string) => void} [log]  receives taskkill failure messages
 */

/**
 * Kill `pid` and its descendants. Never throws.
 *
 * Return contract (deliberately synchronous on every platform so POSIX callers
 * keep their existing control flow):
 *  - POSIX: true when a signal was delivered (group first, then the bare pid if
 *    the group kill threw ESRCH/EPERM), false otherwise.
 *  - win32: taskkill is started fire-and-forget and true is returned
 *    immediately when it was launched; its eventual non-zero exit is reported
 *    through `opts.log`, not the return value. The signal is ignored — taskkill
 *    /F is always forceful.
 *
 * @param {number} pid
 * @param {string | number} [signal]
 * @param {KillTreeOpts} [opts]
 * @returns {boolean}
 */
function killTree(pid, signal, opts = {}) {
  const platform = opts.platform || process.platform;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (platform === 'win32') {
    const execFile = opts.execFile || nodeExecFile;
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
        if (err) {
          try { log(`[killTree] taskkill /PID ${pid} failed: ${err.message}\n`); } catch { /* log must not throw */ }
        }
      });
      return true;
    } catch (e) {
      try { log(`[killTree] taskkill spawn failed: ${e && e.message}\n`); } catch { /* log must not throw */ }
      return false;
    }
  }

  const kill = opts.kill || process.kill.bind(process);
  try { kill(-pid, signal); return true; } catch (e) {
    const code = e && e.code;
    if (code !== 'ESRCH' && code !== 'EPERM') return false;
  }
  try { kill(pid, signal); return true; } catch { return false; }
}

/**
 * spawn() options for a child that killTree() will later kill.
 * `detached` makes it a process-group leader on POSIX; on win32 it would open a
 * console window unless `windowsHide` is set.
 *
 * @param {{ platform?: string }} [opts]
 * @returns {{ detached: true, windowsHide?: true }}
 */
function detachedSpawnOpts(opts = {}) {
  const platform = opts.platform || process.platform;
  return platform === 'win32' ? { detached: true, windowsHide: true } : { detached: true };
}

module.exports = { killTree, detachedSpawnOpts };
