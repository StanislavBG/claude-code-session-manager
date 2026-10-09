'use strict';

/**
 * projectFolder.cjs — create a new, empty project folder from a parent
 * directory + a user-typed name. Electron's `createDirectory` picker property
 * is macOS-only, so the app creates the folder itself.
 *
 * Never throws for validation / exists / io failures; returns a result object.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_NAME_LENGTH = 100;
// NUL + C0 controls + DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * @param {unknown} name
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
function validateProjectName(name) {
  if (typeof name !== 'string') return { ok: false, error: 'Project name must be text.' };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Project name cannot be empty.' };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Project name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  if (trimmed === '.' || trimmed === '..') {
    return { ok: false, error: 'Project name cannot be "." or "..".' };
  }
  if (trimmed.startsWith('-')) return { ok: false, error: 'Project name cannot start with "-".' };
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return { ok: false, error: 'Project name cannot contain "/" or "\\".' };
  }
  if (CONTROL_RE.test(trimmed)) {
    return { ok: false, error: 'Project name cannot contain control characters.' };
  }
  return { ok: true, name: trimmed };
}

/**
 * @param {{ parentDir: string, name: string }} input
 * @returns {Promise<
 *   | { ok: true, path: string }
 *   | { ok: false, code: 'invalid-name' | 'invalid-parent' | 'io', error: string }
 *   | { ok: false, code: 'exists', path: string, error: string }
 * >}
 */
async function createProjectFolder({ parentDir, name } = /** @type {any} */ ({})) {
  const v = validateProjectName(name);
  if (!v.ok) return { ok: false, code: 'invalid-name', error: v.error };

  if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir)) {
    return { ok: false, code: 'invalid-parent', error: 'Parent folder must be an absolute path.' };
  }
  try {
    const st = await fs.promises.stat(parentDir);
    if (!st.isDirectory()) {
      return { ok: false, code: 'invalid-parent', error: `${parentDir} is not a folder.` };
    }
  } catch {
    return { ok: false, code: 'invalid-parent', error: `Parent folder ${parentDir} does not exist.` };
  }

  const target = path.join(parentDir, v.name);
  if (path.dirname(target) !== path.resolve(parentDir)) {
    return { ok: false, code: 'invalid-name', error: 'Project name must be a single folder name.' };
  }

  try {
    await fs.promises.mkdir(target); // non-recursive on purpose
    return { ok: true, path: target };
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e && e.code === 'EEXIST') {
      return {
        ok: false,
        code: 'exists',
        path: target,
        error: `A folder named "${v.name}" already exists in ${parentDir}`,
      };
    }
    return { ok: false, code: 'io', error: (e && e.message) || String(err) };
  }
}

module.exports = { createProjectFolder, validateProjectName };
