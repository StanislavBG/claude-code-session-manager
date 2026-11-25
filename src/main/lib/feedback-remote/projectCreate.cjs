// @ts-check
'use strict';

/**
 * projectCreate.cjs — the logic behind the project_create tool: create a new
 * local project folder for a paired service (and optionally a private GitHub
 * repo for it), so the service can open a Build Epic in it.
 *
 * createServiceProject(input, deps):
 *   1. validates everything before touching disk — any refusal creates nothing;
 *   2. under one module-level queue: answers a repeat (same fromCwd +
 *      externalRef) with the recorded folder, else mkdirs <parentDir>/<name>
 *      (non-recursive, via createProjectFolder), runs `git init` on main with
 *      one empty commit (so Epic worktrees can fork), creates the bare
 *      operations root (so feedback_open_session accepts it as toCwd) and
 *      records it in the created-projects ledger;
 *   3. optionally runs `gh repo create <login>/<name> --private` with the new
 *      folder as source and origin. A GitHub failure keeps the local project.
 *
 * Never throws; returns a result object. Never uses a shell.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createProjectFolder, validateProjectName } = require('../projectFolder.cjs');
const { normalizeExternalRef } = require('../epic/externalRef.cjs');
const { OPS_ROOT_DIR } = require('../opsOwnership.cjs');

const SERVICE_PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GH_TIMEOUT_MS = 60_000;
const GITHUB_REMOTE_RE = /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * @typedef {{ fullName: string, url: string, private: true }} RepoInfo
 * @typedef {import('./createdProjects.cjs').CreatedProjectsStore} Ledger
 * @typedef {(cwd: string, args: string[], opts?: { timeout?: number, env?: Record<string, string> }) => Promise<string>} ExecGit
 * @typedef {(args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string, stderr?: string }>} ExecGh
 * @typedef {{
 *   ledger?: Ledger,
 *   execGit?: ExecGit,
 *   execGh?: ExecGh,
 *   validatePath?: (abs: string) => string,
 *   appendAudit?: (kind: string, fields: Record<string, unknown>) => void,
 * }} Deps
 * @typedef {{
 *   name?: unknown,
 *   parentDir?: unknown,
 *   fromCwd?: unknown,
 *   externalRef?: unknown,
 *   github?: unknown,
 * }} Input
 * @typedef {{ ok: false, status: number, code: string, error: string }} Refusal
 * @typedef {{
 *   ok: true,
 *   status: 'created' | 'existing',
 *   existing?: true,
 *   cwd: string,
 *   name: string,
 *   externalRef: string,
 *   repo: RepoInfo | null,
 *   github?: { ok: false, error: string },
 * }} Success
 */

/** @type {ExecGh} */
function defaultExecGh(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
      cwd: opts.cwd,
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderrText: stderr }));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * @param {Deps} deps
 * @returns {Required<Deps>}
 */
function resolveDeps(deps) {
  return {
    ledger: deps.ledger || require('./createdProjects.cjs').getCreatedProjects(),
    execGit: deps.execGit || require('../git/gitExec.cjs').execGit,
    execGh: deps.execGh || defaultExecGh,
    validatePath: deps.validatePath || ((abs) => require('../../config.cjs').validatePath(abs)),
    appendAudit: deps.appendAudit || ((kind, fields) => {
      require('../telemetry/auditLog.cjs').appendAuditEvent(kind, fields);
    }),
  };
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} error
 * @returns {Refusal}
 */
function refuse(status, code, error) {
  return { ok: false, status, code, error };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  const e = err && typeof err === 'object' ? /** @type {{ stderrText?: unknown, message?: unknown }} */ (err) : null;
  const stderr = e && typeof e.stderrText === 'string' ? e.stderrText.trim() : '';
  if (stderr) return stderr;
  return (e && typeof e.message === 'string' && e.message) || String(err);
}

/**
 * undefined/false = no repo; true = {}; an object may carry owner + private.
 * @param {unknown} github
 * @returns {{ ok: true, value: { owner?: string } | null } | { ok: false, error: string }}
 */
function normalizeGithub(github) {
  if (github === undefined || github === null || github === false) return { ok: true, value: null };
  if (github === true) return { ok: true, value: {} };
  if (typeof github !== 'object' || Array.isArray(github)) {
    return { ok: false, error: 'github must be true, false or { owner?, private? }.' };
  }
  const g = /** @type {Record<string, unknown>} */ (github);
  if (g.private === false) return { ok: false, error: 'Only private GitHub repositories can be created.' };
  if (g.private !== undefined && g.private !== true) {
    return { ok: false, error: 'github.private must be true when given.' };
  }
  if (g.owner !== undefined && (typeof g.owner !== 'string' || !g.owner.trim())) {
    return { ok: false, error: 'github.owner must be a non-empty string when given.' };
  }
  return { ok: true, value: typeof g.owner === 'string' ? { owner: g.owner.trim() } : {} };
}

/**
 * @param {string} url
 * @returns {RepoInfo | null}
 */
function parseGithubRemote(url) {
  const m = GITHUB_REMOTE_RE.exec(String(url || '').trim());
  if (!m) return null;
  const fullName = `${m[1]}/${m[2]}`;
  return { fullName, url: `https://github.com/${fullName}`, private: true };
}

/**
 * @param {ExecGit} execGit
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function readOrigin(execGit, cwd) {
  try {
    const out = (await execGit(cwd, ['remote', 'get-url', 'origin'])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Create the private repo, wire it as origin, record it.
 * @param {Required<Deps>} d
 * @param {string} cwd
 * @param {string} login
 * @param {string} name
 * @returns {Promise<{ ok: true, repo: RepoInfo } | { ok: false, error: string }>}
 */
async function runGithubStep(d, cwd, login, name) {
  try {
    await d.execGh(
      ['repo', 'create', `${login}/${name}`, '--private', `--source=${cwd}`, '--remote=origin', '--push'],
      { cwd },
    );
  } catch (err) {
    return { ok: false, error: `gh repo create failed: ${errText(err)}` };
  }
  const origin = await readOrigin(d.execGit, cwd);
  const repo = origin ? parseGithubRemote(origin) : null;
  if (!repo) return { ok: false, error: `origin is not a GitHub remote after gh repo create: ${origin || '(unset)'}` };
  try {
    await d.ledger.setRepo(cwd, repo.url);
  } catch (err) {
    return { ok: false, error: `could not record the repo: ${errText(err)}` };
  }
  return { ok: true, repo };
}

/** @param {unknown} err */
function isIdentityError(err) {
  const t = errText(err);
  return /tell me who you are|user\.email|user\.name|empty ident|unable to auto-detect email/i.test(t);
}

/** @type {Promise<unknown>} */
let queue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialize(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * @param {Input} input
 * @param {Deps} [deps]
 * @returns {Promise<Success | Refusal>}
 */
async function createServiceProject(input, deps = {}) {
  const d = resolveDeps(deps || {});
  const { name, parentDir, fromCwd, externalRef, github } = input && typeof input === 'object' ? input : /** @type {Input} */ ({});

  const ref = normalizeExternalRef(externalRef);
  if (!ref.ok) return refuse(400, 'invalid-ref', ref.error);
  if (!ref.value) return refuse(400, 'invalid-ref', 'externalRef is required.');
  const refValue = ref.value;

  if (typeof fromCwd !== 'string' || !path.isAbsolute(fromCwd) || fromCwd.includes('\0')) {
    return refuse(400, 'invalid-ref', 'fromCwd must be an absolute path.');
  }
  const from = path.resolve(fromCwd);

  if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir) || parentDir.includes('\0')) {
    return refuse(400, 'invalid-parent', 'parentDir must be an absolute path.');
  }
  try {
    d.validatePath(parentDir);
  } catch (err) {
    return refuse(400, 'invalid-parent', errText(err));
  }
  try {
    if (!fs.statSync(parentDir).isDirectory()) {
      return refuse(400, 'invalid-parent', `${parentDir} is not a folder.`);
    }
  } catch {
    return refuse(400, 'invalid-parent', `Parent folder ${parentDir} does not exist.`);
  }
  const parent = path.resolve(parentDir);

  const v = validateProjectName(name);
  if (!v.ok) return refuse(400, 'invalid-name', v.error);
  if (v.name !== name || !SERVICE_PROJECT_NAME_RE.test(v.name)) {
    return refuse(400, 'invalid-name', 'Project name must be 1 to 100 letters, digits or . _ - and start with a letter or digit.');
  }
  if (/\.git$/i.test(v.name)) return refuse(400, 'invalid-name', 'Project name cannot end in ".git".');
  const projectName = v.name;

  const g = normalizeGithub(github);
  if (!g.ok) return refuse(400, 'invalid-github', g.error);
  /** @type {string | null} */
  let login = null;
  if (g.value) {
    try {
      const { stdout } = await d.execGh(['api', 'user', '--jq', '.login']);
      login = String(stdout || '').trim();
    } catch (err) {
      return refuse(400, 'gh-unavailable', `gh is not available or not signed in: ${errText(err)}`);
    }
    if (!login) return refuse(400, 'gh-unavailable', 'gh api user returned no login.');
    if (g.value.owner && g.value.owner.toLowerCase() !== login.toLowerCase()) {
      return refuse(403, 'gh-owner', `github.owner ${g.value.owner} is not the signed-in gh account.`);
    }
  }

  return serialize(async () => {
    const recorded = d.ledger.findByRef(from, refValue);
    if (recorded) return answerExisting(d, recorded.cwd, refValue, login);

    const made = await createProjectFolder({ parentDir: parent, name: projectName });
    if (!made.ok) {
      if (made.code === 'exists') return refuse(409, 'exists', made.error);
      if (made.code === 'invalid-name') return refuse(400, 'invalid-name', made.error);
      if (made.code === 'invalid-parent') return refuse(400, 'invalid-parent', made.error);
      return refuse(500, 'io', made.error);
    }
    const cwd = made.path;

    /** @param {string} msg */
    const rollback = async (msg) => {
      try { await fs.promises.rm(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
      return refuse(500, 'io', msg);
    };

    try {
      await d.execGit(cwd, ['init', '--initial-branch=main']);
    } catch (err) {
      return rollback(`git init failed: ${errText(err)}`);
    }
    try {
      await d.execGit(cwd, ['commit', '--allow-empty', '-m', 'Initial commit']);
    } catch (err) {
      const hint = isIdentityError(err)
        ? ' Set git user.name and user.email (git config --global user.name / user.email) and retry.'
        : '';
      return rollback(`git commit failed: ${errText(err)}.${hint}`);
    }
    try {
      await fs.promises.mkdir(path.join(cwd, OPS_ROOT_DIR));
    } catch (err) {
      return rollback(`could not create ${OPS_ROOT_DIR}/: ${errText(err)}`);
    }
    try {
      await d.ledger.record({ cwd, fromCwd: from, externalRef: refValue, repo: null });
    } catch (err) {
      return rollback(`could not record the project: ${errText(err)}`);
    }
    try {
      d.appendAudit('project_created', { cwd, fromCwd: from, externalRef: refValue, repo: null });
    } catch { /* best effort */ }

    /** @type {Success} */
    const answer = { ok: true, status: 'created', cwd, name: projectName, externalRef: refValue, repo: null };
    if (login) {
      const gh = await runGithubStep(d, cwd, login, projectName);
      if (gh.ok) answer.repo = gh.repo;
      else answer.github = { ok: false, error: gh.error };
    }
    return answer;
  });
}

/**
 * @param {Required<Deps>} d
 * @param {string} cwd
 * @param {string} externalRef
 * @param {string | null} login
 * @returns {Promise<Success | Refusal>}
 */
async function answerExisting(d, cwd, externalRef, login) {
  let present = false;
  try { present = fs.statSync(cwd).isDirectory(); } catch { present = false; }
  if (!present) return refuse(409, 'gone', `The project created for ${externalRef} no longer exists at ${cwd}.`);
  const name = path.basename(cwd);
  const origin = await readOrigin(d.execGit, cwd);
  /** @type {Success} */
  const answer = {
    ok: true,
    status: 'existing',
    existing: true,
    cwd,
    name,
    externalRef,
    repo: origin ? parseGithubRemote(origin) : null,
  };
  if (login && !origin) {
    const gh = await runGithubStep(d, cwd, login, name);
    if (gh.ok) answer.repo = gh.repo;
    else answer.github = { ok: false, error: gh.error };
  }
  return answer;
}

module.exports = { createServiceProject, SERVICE_PROJECT_NAME_RE, parseGithubRemote };
