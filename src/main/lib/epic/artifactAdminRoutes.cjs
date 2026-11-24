// @ts-check
/**
 * artifactAdminRoutes.cjs — loopback admin HTTP routes in front of the per-project
 * Artifacts store (artifactStore.cjs, the ONE writer of `artifacts/`). The artifact
 * MCP tool and other local callers reach the store only through here:
 *   POST /admin/artifacts/publish { path, title?, kind?, cwd?, originClaudeSessionId?, sourcePromptId? }
 *        -> { ok, storedPath, revealPath, entry }
 *   GET  /admin/artifacts?cwd=                                   -> { ok, projectRoot, artifacts }
 *
 * The bearer-token check is the transport's (localAdminHttp.cjs handleRequest), shared
 * by every admin route. The calling project + Epic come from resolveProjectContext
 * (projectRootResolve.cjs), so a caller inside an Epic worktree, or one that only knows
 * its claude session id, still lands on the main project and its Epic. A relative
 * `path` resolves against that Epic's worktree when known, else the project root.
 * Allowed source roots: project root, the Epic worktree, the artifact staging base,
 * os.tmpdir().
 *
 * Refusals are 4xx `{ ok:false, error, message }` where `error` names the reason:
 * bad_request, no_project, no_epic, not_found, outside_root, not_a_file, too_large,
 * refused. Deliberately NO route that mints an Epic (SINGLE-CREATOR LAW, epicMint.cjs).
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const { readBody, sendJson } = require('../feedback-remote/localAdminHttp.cjs');

const MAX_PATH = 4096;
const MAX_TITLE = 500;
const MAX_ID = 200;

class RouteError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @param {string} message */
const bad = (message) => new RouteError(400, 'bad_request', message);

/** @param {any} req @returns {Promise<Record<string, unknown>>} */
async function readJsonBody(req) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (/** @type {any} */ e) {
    throw bad(`request body rejected: ${e?.message ?? 'unreadable'}`);
  }
  /** @type {any} */
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw bad('invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
  return body;
}

/** @param {unknown} v @param {string} name @param {number} max @returns {string | undefined} */
function optString(v, name, max) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} must be a string of at most ${max} characters`);
  return v;
}

/** @param {unknown} v @returns {string | undefined} */
function optAbsCwd(v) {
  const s = optString(v, 'cwd', MAX_PATH);
  if (s !== undefined && !path.isAbsolute(s)) throw bad('cwd must be an absolute path');
  return s;
}

/**
 * Map an artifactStore refusal string to a status + reason code.
 * @param {string} error
 * @returns {RouteError}
 */
function storeRefusal(error) {
  const msg = String(error || 'publish refused');
  if (/outside every allowed root|already inside the artifacts store/.test(msg)) return new RouteError(400, 'outside_root', msg);
  if (/not a regular file|is a symlink/.test(msg)) return new RouteError(400, 'not_a_file', msg);
  if (/oversize/.test(msg)) return new RouteError(413, 'too_large', msg);
  if (/source unreadable|source unresolvable/.test(msg)) {
    return /ENOENT/.test(msg) ? new RouteError(404, 'not_found', msg) : new RouteError(400, 'not_a_file', msg);
  }
  if (/kind must be|absolute path|unsafe epicId|exactly one of/.test(msg)) return new RouteError(400, 'bad_request', msg);
  if (/copy failed|ledger write failed|publish failed/.test(msg)) return new RouteError(500, 'internal', msg);
  return new RouteError(400, 'refused', msg);
}

/** The artifact staging base (<worktreeBase>/artifact-staging), or null when unresolvable. */
function defaultStagingBase() {
  try {
    const { worktreeBase } = require('../scheduler/schedulerPaths.cjs');
    return path.join(worktreeBase(), 'artifact-staging');
  } catch {
    return null;
  }
}

/**
 * The Epic's own worktree dir from its PromptSession (`worktree.dir`), or null.
 * @param {(cwd: string) => { sessions: Record<string, any> }} readActiveIndexFn
 * @param {string} projectCwd
 * @param {string} epicId
 * @returns {string | null}
 */
function epicWorktreeDir(readActiveIndexFn, projectCwd, epicId) {
  try {
    const { sessions } = readActiveIndexFn(projectCwd);
    const dir = sessions && sessions[epicId] && sessions[epicId].worktree && sessions[epicId].worktree.dir;
    return typeof dir === 'string' && path.isAbsolute(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * @param {(req: any, query: URLSearchParams) => Promise<Record<string, unknown>>} fn
 */
function route(fn) {
  return async (/** @type {any} */ req, /** @type {any} */ res, /** @type {URLSearchParams} */ query) => {
    try {
      sendJson(res, 200, await fn(req, query || new URLSearchParams()));
    } catch (e) {
      if (e instanceof RouteError) {
        sendJson(res, e.status, { ok: false, error: e.code, message: e.message });
        return;
      }
      sendJson(res, 500, { ok: false, error: 'internal', message: e instanceof Error ? e.message : 'request failed' });
    }
  };
}

/**
 * @typedef {{
 *   store?: { publishArtifact: Function, listArtifacts: Function },
 *   resolveProjectContext?: Function,
 *   readActiveIndex?: (cwd: string) => { sessions: Record<string, any> },
 *   stagingBase?: () => string | null,
 *   tmpdir?: () => string,
 * }} ArtifactRouteDeps
 */

/**
 * @param {any} adminHttp
 * @param {ArtifactRouteDeps} [deps] test seams
 */
function registerAdminRoute(adminHttp, deps = {}) {
  const store = () => deps.store || require('./artifactStore.cjs');
  const resolveCtx = (/** @type {any} */ args) => (
    deps.resolveProjectContext || require('../projectRootResolve.cjs').resolveProjectContext
  )(args);
  const readIndex = (/** @type {string} */ cwd) => (deps.readActiveIndex || require('./epicMint.cjs').readActiveIndex)(cwd);
  const stagingBase = deps.stagingBase || defaultStagingBase;
  const tmpdir = deps.tmpdir || os.tmpdir;

  adminHttp.registerRoute('POST', '/admin/artifacts/publish', route(async (req) => {
    const b = await readJsonBody(req);
    const rawPath = optString(b.path, 'path', MAX_PATH);
    if (!rawPath) throw bad('path is required');
    const title = optString(b.title, 'title', MAX_TITLE);
    const kind = optString(b.kind, 'kind', 20);
    const cwd = optAbsCwd(b.cwd);
    const originClaudeSessionId = optString(b.originClaudeSessionId, 'originClaudeSessionId', MAX_ID);
    const sourcePromptId = optString(b.sourcePromptId, 'sourcePromptId', MAX_ID);

    const ctx = resolveCtx({ cwd, originClaudeSessionId, epicId: sourcePromptId }) || {};
    const projectRoot = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : null;
    if (!projectRoot) throw new RouteError(400, 'no_project', 'could not resolve the calling project: give cwd, originClaudeSessionId or sourcePromptId');
    const epicId = typeof ctx.epicId === 'string' && ctx.epicId ? ctx.epicId : null;
    if (!epicId) throw new RouteError(400, 'no_epic', 'no Epic resolved for this caller: give originClaudeSessionId or sourcePromptId of an Epic in this project');

    const worktreeDir = epicWorktreeDir(readIndex, ctx.epicCwd || projectRoot, epicId);
    const srcPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(worktreeDir || projectRoot, rawPath);
    const allowedRoots = [projectRoot, worktreeDir, stagingBase(), tmpdir()]
      .filter((r) => typeof r === 'string' && path.isAbsolute(r));

    const result = await store().publishArtifact({
      projectRoot,
      epicId,
      srcPath,
      title,
      kind,
      producer: { epicId, sessionId: originClaudeSessionId || null },
      allowedRoots,
    });
    if (!result || !result.ok) throw storeRefusal(result && result.error);
    const revealPath = path.relative(projectRoot, result.storedPath).split(path.sep).join('/');
    return { ok: true, storedPath: result.storedPath, revealPath, entry: result.entry };
  }));

  adminHttp.registerRoute('GET', '/admin/artifacts', route(async (_req, q) => {
    const cwd = optAbsCwd(q.get('cwd'));
    if (!cwd) throw bad('cwd is required (absolute path)');
    const ctx = resolveCtx({ cwd }) || {};
    const projectRoot = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : null;
    if (!projectRoot) throw new RouteError(400, 'no_project', `could not resolve a project for ${cwd}`);
    return { ok: true, projectRoot, artifacts: store().listArtifacts(projectRoot) };
  }));
}

module.exports = { registerAdminRoute };
