/**
 * appRuntime.cjs — how to run a Node script from an EXTERNAL process.
 *
 * Packaged installer builds may have no system `node`, so scripts handed to
 * Claude Code hooks / MCP registrations run through the app's own binary with
 * ELECTRON_RUN_AS_NODE=1. npx/dev builds keep using `node`.
 */

'use strict';

/**
 * @param {{ packaged?: boolean }} [opts]
 * @returns {boolean}
 */
function isPackagedApp(opts) {
  if (opts && typeof opts.packaged === 'boolean') return opts.packaged;
  if (process.env.SM_FORCE_PACKAGED === '1') return true;
  try {
    return require('electron').app?.isPackaged === true;
  } catch {
    return false;
  }
}

/**
 * @param {string} scriptPath
 * @param {{ packaged?: boolean, execPath?: string }} [opts]
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
function nodeSpawnSpec(scriptPath, opts) {
  if (!isPackagedApp(opts)) return { command: 'node', args: [scriptPath], env: {} };
  return {
    command: (opts && opts.execPath) || process.execPath,
    args: [scriptPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** @param {string} p */
function quote(p) {
  if (p.includes('"')) throw new Error(`appRuntime: path contains a double quote: ${p}`);
  return `"${p}"`;
}

/**
 * Shell command string (hook `command` fields). Paths are double-quoted.
 * @param {string} scriptPath
 * @param {{ packaged?: boolean, execPath?: string }} [opts]
 * @returns {string}
 */
function nodeShellCommand(scriptPath, opts) {
  if (!isPackagedApp(opts)) return `node ${quote(scriptPath)}`;
  const execPath = (opts && opts.execPath) || process.execPath;
  return `ELECTRON_RUN_AS_NODE=1 ${quote(execPath)} ${quote(scriptPath)}`;
}

module.exports = { isPackagedApp, nodeSpawnSpec, nodeShellCommand };
