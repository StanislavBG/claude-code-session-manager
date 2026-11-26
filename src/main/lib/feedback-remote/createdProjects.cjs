// @ts-check
'use strict';

/**
 * createdProjects.cjs — store of every project folder the project_create tool
 * created. Pure Node — no Electron — importable in unit tests.
 *
 * File (default ~/.claude/session-manager/created-projects.json, mode 0600,
 * override SM_CREATED_PROJECTS_FILE):
 *   { version: 1, projects: [{ cwd, fromCwd, externalRef, repo, createdAt }] }
 *
 * - A repeat project_create with the same (fromCwd, externalRef) answers with
 *   the same folder via findByRef.
 * - The project list can include a folder before it has any Claude transcript
 *   via list().
 *
 * Mirrors servicePairings.cjs: state is read once from disk (missing/corrupt =
 * empty) and kept in memory; every mutation is written atomically, serialized
 * through one queue. Reads are synchronous over the in-memory copy. This store
 * is the only writer of that file (it lives under ~/.claude, not an ops root).
 */

const path = require('node:path');
const { writeTextAtomic, readJsonOrSync } = require('../util/atomicFs.cjs');

const STORE_VERSION = 1;
const MAX_PROJECTS = 1000;
const MAX_EXTERNAL_REF_LEN = 200;
const MAX_REPO_LEN = 200;

/**
 * @typedef {{ cwd: string, fromCwd: string, externalRef: string, repo: string | null, createdAt: number }} CreatedProject
 * @typedef {{ version: number, projects: CreatedProject[] }} StoreState
 * @typedef {{ cwd?: unknown, fromCwd?: unknown, externalRef?: unknown, repo?: unknown }} RecordInput
 * @typedef {{
 *   findByRef: (fromCwd: unknown, externalRef: unknown) => CreatedProject | null,
 *   findByCwd: (cwd: unknown) => CreatedProject | null,
 *   record: (input: RecordInput) => Promise<CreatedProject>,
 *   setRepo: (cwd: unknown, repo: unknown) => Promise<CreatedProject | null>,
 *   list: () => CreatedProject[],
 * }} CreatedProjectsStore
 */

/** @returns {string} */
function defaultFilePath() {
  const override = process.env.SM_CREATED_PROJECTS_FILE;
  if (typeof override === 'string' && override.length > 0) return override;
  const { claudeHome } = require('../scheduler/schedulerPaths.cjs');
  return path.join(claudeHome(), 'session-manager', 'created-projects.json');
}

/**
 * @param {unknown} p
 * @returns {p is string}
 */
function isAbsPath(p) {
  return typeof p === 'string' && p.length > 0 && path.isAbsolute(p) && !p.includes('\0');
}

/**
 * @param {unknown} p
 * @param {string} label
 * @returns {string}
 */
function validateAbs(p, label) {
  if (!isAbsPath(p)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(p);
}

/**
 * @param {unknown} ref
 * @returns {string}
 */
function validateExternalRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_EXTERNAL_REF_LEN) {
    throw new Error(`externalRef must be a string of 1 to ${MAX_EXTERNAL_REF_LEN} chars`);
  }
  return ref;
}

/**
 * @param {unknown} repo
 * @param {boolean} allowNull
 * @returns {string | null}
 */
function validateRepo(repo, allowNull) {
  if (allowNull && (repo === undefined || repo === null)) return null;
  if (typeof repo !== 'string' || repo.length === 0 || repo.length > MAX_REPO_LEN || /[\r\n\0]/.test(repo)) {
    throw new Error(`repo must be a one-line string of 1 to ${MAX_REPO_LEN} chars`);
  }
  return repo;
}

/**
 * @param {CreatedProject} e
 * @returns {CreatedProject}
 */
function copy(e) {
  return { cwd: e.cwd, fromCwd: e.fromCwd, externalRef: e.externalRef, repo: e.repo, createdAt: e.createdAt };
}

/**
 * @param {unknown} e
 * @returns {e is CreatedProject}
 */
function isEntry(e) {
  if (!e || typeof e !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (e);
  return isAbsPath(r.cwd) && isAbsPath(r.fromCwd)
    && typeof r.externalRef === 'string' && r.externalRef.length > 0
    && typeof r.createdAt === 'number';
}

/**
 * A repo read from disk: kept only when it passes validateRepo, else null.
 * @param {unknown} repo
 * @returns {string | null}
 */
function loadedRepo(repo) {
  if (typeof repo !== 'string') return null;
  try {
    return validateRepo(repo, false);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {StoreState}
 */
function normalizeLoaded(raw) {
  /** @type {StoreState} */
  const empty = { version: STORE_VERSION, projects: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const list = /** @type {{ projects?: unknown }} */ (raw).projects;
  if (!Array.isArray(list)) return empty;
  const projects = list.filter(isEntry).map((e) => ({
    cwd: path.resolve(e.cwd),
    fromCwd: path.resolve(e.fromCwd),
    externalRef: e.externalRef,
    repo: loadedRepo(e.repo),
    createdAt: e.createdAt,
  }));
  return { version: STORE_VERSION, projects: projects.slice(-MAX_PROJECTS) };
}

/**
 * @param {{ filePath?: string, now?: () => number }} [opts]
 * @returns {CreatedProjectsStore}
 */
function createCreatedProjects({ filePath, now } = {}) {
  const file = filePath || defaultFilePath();
  const clock = typeof now === 'function' ? now : () => Date.now();
  /** @type {StoreState | null} */
  let state = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** @returns {StoreState} */
  function load() {
    if (!state) state = normalizeLoaded(readJsonOrSync(file, null));
    return state;
  }

  /**
   * Run a mutation then persist; serialized so writes never interleave.
   * @template T
   * @param {(s: StoreState) => T} fn
   * @returns {Promise<T>}
   */
  function mutate(fn) {
    const run = queue.then(async () => {
      /** @type {StoreState} */
      const next = JSON.parse(JSON.stringify(load()));
      const result = fn(next);
      await writeTextAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      state = next;
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  /**
   * @param {StoreState} s
   * @param {string} cwd
   */
  function entryByCwd(s, cwd) {
    return s.projects.find((e) => e.cwd === cwd) || null;
  }

  /**
   * @param {StoreState} s
   * @param {string} fromCwd
   * @param {string} externalRef
   */
  function entryByRef(s, fromCwd, externalRef) {
    return s.projects.find((e) => e.fromCwd === fromCwd && e.externalRef === externalRef) || null;
  }

  return {
    findByRef(fromCwd, externalRef) {
      if (!isAbsPath(fromCwd) || typeof externalRef !== 'string' || externalRef.length === 0) return null;
      const e = entryByRef(load(), path.resolve(fromCwd), externalRef);
      return e ? copy(e) : null;
    },

    findByCwd(cwd) {
      if (!isAbsPath(cwd)) return null;
      const e = entryByCwd(load(), path.resolve(cwd));
      return e ? copy(e) : null;
    },

    record(input) {
      /** @type {string} */ let cwd;
      /** @type {string} */ let fromCwd;
      /** @type {string} */ let externalRef;
      /** @type {string | null} */ let repo;
      try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new Error('record expects { cwd, fromCwd, externalRef, repo? }');
        }
        cwd = validateAbs(input.cwd, 'cwd');
        fromCwd = validateAbs(input.fromCwd, 'fromCwd');
        externalRef = validateExternalRef(input.externalRef);
        repo = validateRepo(input.repo, true);
      } catch (e) {
        return Promise.reject(e);
      }
      return mutate((s) => {
        const byCwd = entryByCwd(s, cwd);
        if (byCwd) {
          if (byCwd.fromCwd === fromCwd && byCwd.externalRef === externalRef) return copy(byCwd);
          throw new Error(`cwd is already recorded under another externalRef: ${cwd}`);
        }
        const byRef = entryByRef(s, fromCwd, externalRef);
        if (byRef) throw new Error(`externalRef already names a different cwd: ${byRef.cwd}`);
        /** @type {CreatedProject} */
        const entry = { cwd, fromCwd, externalRef, repo, createdAt: clock() };
        s.projects.push(entry);
        if (s.projects.length > MAX_PROJECTS) s.projects = s.projects.slice(-MAX_PROJECTS);
        return copy(entry);
      });
    },

    setRepo(cwd, repo) {
      /** @type {string} */ let want;
      /** @type {string} */ let value;
      try {
        want = validateAbs(cwd, 'cwd');
        value = /** @type {string} */ (validateRepo(repo, false));
      } catch (e) {
        return Promise.reject(e);
      }
      return mutate((s) => {
        const e = entryByCwd(s, want);
        if (!e) return null;
        e.repo = value;
        return copy(e);
      });
    },

    list() {
      const items = load().projects.map((e, i) => ({ e, i }));
      items.sort((a, b) => (b.e.createdAt - a.e.createdAt) || (b.i - a.i));
      return items.map(({ e }) => copy(e));
    },
  };
}

/** @type {CreatedProjectsStore | null} */
let singleton = null;

/** @returns {CreatedProjectsStore} */
function getCreatedProjects() {
  if (!singleton) singleton = createCreatedProjects();
  return singleton;
}

function __resetCreatedProjectsForTests() {
  singleton = null;
}

module.exports = {
  createCreatedProjects,
  getCreatedProjects,
  __resetCreatedProjectsForTests,
  MAX_PROJECTS,
  MAX_EXTERNAL_REF_LEN,
};
