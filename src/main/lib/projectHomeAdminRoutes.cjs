/**
 * projectHomeAdminRoutes.cjs — the single admin route behind the
 * `project_home_write` MCP tool: POST /admin/project-home/write {cwd, html}
 * writes one self-contained HTML document to
 * `session-manager-operations/project-pages/home.html` (owner: project-home,
 * see opsOwnership.cjs). Registered against the same injected
 * localAdminHttp.cjs transport as prdAdminRoutes.cjs.
 *
 * "Self-contained" is enforced here, not trusted: the document must not
 * reference any remote resource (`<script src>`, `<link href=http*>`,
 * remote `@import` / `url(http*)`), so opening it never causes network egress.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { resolveProjectContext } = require('./projectRootResolve.cjs');
const { opsPath, OPS_ROOT_DIR } = require('./opsOwnership.cjs');
const config = require('../config.cjs');
const { schemas } = require('../ipcSchemas.cjs');

const MAX_HTML_BYTES = 1024 * 1024;

// Each detector is a linear regex scan; the input is capped at 1MB first.
const REMOTE_REFERENCE_CHECKS = [
  { re: /<script\b[^>]*\bsrc\s*=/i, message: '<script src> is not allowed — inline all scripts' },
  { re: /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i, message: '<link href="http(s)://…"> is not allowed — inline all styles' },
  { re: /@import\b/i, message: '@import is not allowed — inline all styles' },
  { re: /url\(\s*["']?\s*(?:https?:)?\/\//i, message: 'url(http(s)://…) is not allowed — embed assets as data: URIs' },
];

/** -> null when `html` is acceptable, else a human-readable rejection reason. */
function validateHomeHtml(html) {
  if (typeof html !== 'string' || html.trim().length === 0) return 'html must be a non-empty string';
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return `html exceeds the ${MAX_HTML_BYTES}-byte limit`;
  for (const { re, message } of REMOTE_REFERENCE_CHECKS) {
    if (re.test(html)) return `html must be self-contained: ${message}`;
  }
  return null;
}

/** Same definition crossProjectFeedback.cjs uses for "is this a Session
 * Manager project": it already has an operations root. */
function isSessionManagerProject(cwd) {
  try {
    return fs.statSync(path.join(cwd, OPS_ROOT_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve a caller-supplied cwd into a real Session Manager project root.
 * Never throws — returns a structured verdict. */
function resolveCwd(rawCwd) {
  if (!rawCwd || typeof rawCwd !== 'string') {
    return { ok: false, status: 400, error: 'cwd is required' };
  }
  if (!path.isAbsolute(rawCwd)) {
    return { ok: false, status: 400, error: 'cwd must be an absolute path' };
  }
  // Normalizes a worktree/ops-internal cwd to its real project root so a
  // headless job inside an Epic's worktree still targets the right project.
  const resolved = resolveProjectContext({ cwd: rawCwd });
  const candidate = resolved.cwd || rawCwd;
  let realCwd;
  try {
    realCwd = config.validatePath(candidate);
  } catch (e) {
    return { ok: false, status: 400, error: `cwd rejected: ${e?.message ?? 'outside allowed roots'}` };
  }
  if (!isSessionManagerProject(realCwd)) {
    return {
      ok: false,
      status: 400,
      error: `${realCwd} is not a Session Manager project — it has no ${OPS_ROOT_DIR}/ directory`,
    };
  }
  return { ok: true, cwd: realCwd };
}

function registerAdminRoute(adminHttp) {
  // POST /admin/project-home/write {cwd, html}
  adminHttp.registerRoute('POST', '/admin/project-home/write', async (req, res) => {
    // Allow headroom over MAX_HTML_BYTES for JSON escaping; the html byte
    // limit itself is enforced by validateHomeHtml below.
    let raw;
    try {
      raw = await readBody(req, MAX_HTML_BYTES * 2 + 4096);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'} (html limit is ${MAX_HTML_BYTES} bytes)` });
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    let input;
    try {
      input = schemas.projectHomeAdminWriteBody.parse(body);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid payload', details: e?.issues ?? e?.message });
      return;
    }
    const resolved = resolveCwd(input.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    const rejection = validateHomeHtml(input.html);
    if (rejection) {
      sendJson(res, 400, { ok: false, error: rejection });
      return;
    }
    // Only a route that is actually about to write widens config.cjs's
    // write boundary to this project root.
    config.addAllowedRoot(resolved.cwd);
    try {
      const homePath = opsPath(resolved.cwd, 'project-pages', 'home.html');
      await config.writeTextAtomic(homePath, input.html, { writer: 'project-home' });
      sendJson(res, 200, { ok: true, path: homePath, bytes: Buffer.byteLength(input.html, 'utf8') });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'write failed' });
    }
  });
}

module.exports = { registerAdminRoute, validateHomeHtml, MAX_HTML_BYTES };
