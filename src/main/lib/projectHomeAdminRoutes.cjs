/**
 * projectHomeAdminRoutes.cjs — the two admin routes behind the
 * project_home_write MCP tool and its demo-video sibling:
 *   POST /admin/project-home/write              {cwd, html} -> project-pages/home.html
 *   POST /admin/project-home/demo-video/write   {cwd, html} -> project-pages/demo-video/index.html
 * both owned by writer 'project-home' (see opsOwnership.cjs). Registered
 * against the same injected localAdminHttp.cjs transport as
 * prdAdminRoutes.cjs.
 *
 * "Self-contained" is enforced here, not trusted: the document must not
 * reference any remote resource (`<script src>`, `<link href=http*>`,
 * remote `@import` / `url(http*)`), so opening it never causes network egress.
 *
 * The demo-video document runs inline JavaScript (the home page does not), so
 * it additionally rejects network-capable APIs (fetch, WebSocket, dynamic
 * import, …) and has a Content-Security-Policy meta stamped into <head>
 * before it is written — the real network fence, since the viewer renders it
 * via smfile:// in a sandboxed iframe that sends no CSP header itself. The
 * regex checks below are defence in depth, not the control.
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
const MAX_DEMO_VIDEO_BYTES = 2 * 1024 * 1024;

// Each detector is a linear regex scan; the input is capped first.
const REMOTE_REFERENCE_CHECKS = [
  { re: /<script\b[^>]*\bsrc\s*=/i, message: '<script src> is not allowed — inline all scripts' },
  { re: /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i, message: '<link href="http(s)://…"> is not allowed — inline all styles' },
  { re: /@import\b/i, message: '@import is not allowed — inline all styles' },
  { re: /url\(\s*["']?\s*(?:https?:)?\/\//i, message: 'url(http(s)://…) is not allowed — embed assets as data: URIs' },
];

// Demo-video documents run inline JS; these reject the network-capable
// surface a self-contained, CSP-fenced document must never reach for.
const NETWORK_CHECKS = [
  { re: /\bfetch\s*\(/i, message: 'fetch(...) is not allowed' },
  { re: /\bXMLHttpRequest\b/i, message: 'XMLHttpRequest is not allowed' },
  { re: /\bWebSocket\b/i, message: 'WebSocket is not allowed' },
  { re: /\bEventSource\b/i, message: 'EventSource is not allowed' },
  { re: /\bsendBeacon\b/i, message: 'sendBeacon is not allowed' },
  { re: /\bimport\s*\(/i, message: 'import(...) is not allowed' },
  { re: /\bimportScripts\b/i, message: 'importScripts is not allowed' },
  { re: /<iframe\b/i, message: '<iframe> is not allowed' },
  { re: /<object\b/i, message: '<object> is not allowed' },
  { re: /<embed\b/i, message: '<embed> is not allowed' },
  { re: /\bwindow\.open\b/i, message: 'window.open is not allowed' },
  { re: /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, message: 'src=/href= pointing at http(s): or // is not allowed' },
];

const DURATION_META_RE = /<meta\b[^>]*\bname\s*=\s*["']sm-demo-duration["'][^>]*\bcontent\s*=\s*["'](\d+)["'][^>]*>/i;
const MIN_DEMO_DURATION_S = 5;
const MAX_DEMO_DURATION_S = 30;

const DEMO_VIDEO_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src \'none\'">';

/** -> null when `html` is acceptable, else a human-readable rejection reason. */
function validateHomeHtml(html) {
  if (typeof html !== 'string' || html.trim().length === 0) return 'html must be a non-empty string';
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return `html exceeds the ${MAX_HTML_BYTES}-byte limit`;
  for (const { re, message } of REMOTE_REFERENCE_CHECKS) {
    if (re.test(html)) return `html must be self-contained: ${message}`;
  }
  return null;
}

/** -> null when `html` is acceptable, else a human-readable rejection reason. */
function validateDemoVideoHtml(html) {
  if (typeof html !== 'string' || html.trim().length === 0) return 'html must be a non-empty string';
  if (Buffer.byteLength(html, 'utf8') > MAX_DEMO_VIDEO_BYTES) return `html exceeds the ${MAX_DEMO_VIDEO_BYTES}-byte limit`;
  for (const { re, message } of REMOTE_REFERENCE_CHECKS) {
    if (re.test(html)) return `html must be self-contained: ${message}`;
  }
  for (const { re, message } of NETWORK_CHECKS) {
    if (re.test(html)) return `html must not be network-capable: ${message}`;
  }
  const match = html.match(DURATION_META_RE);
  if (!match) {
    return 'html must declare <meta name="sm-demo-duration" content="N"> with '
      + `${MIN_DEMO_DURATION_S} <= N <= ${MAX_DEMO_DURATION_S}`;
  }
  const duration = Number(match[1]);
  if (!Number.isFinite(duration) || duration < MIN_DEMO_DURATION_S || duration > MAX_DEMO_DURATION_S) {
    return `sm-demo-duration must be between ${MIN_DEMO_DURATION_S} and ${MAX_DEMO_DURATION_S}, got ${match[1]}`;
  }
  return null;
}

/**
 * Stamps DEMO_VIDEO_CSP in as the first child of <head> (replacing any CSP
 * meta already present), creating <head> if the document has none.
 */
function injectCsp(html) {
  const stripped = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>\s*/gi, '');
  if (/<head\b[^>]*>/i.test(stripped)) {
    return stripped.replace(/<head\b[^>]*>/i, (openTag) => `${openTag}${DEMO_VIDEO_CSP}`);
  }
  if (/<html\b[^>]*>/i.test(stripped)) {
    return stripped.replace(/<html\b[^>]*>/i, (openTag) => `${openTag}<head>${DEMO_VIDEO_CSP}</head>`);
  }
  return `<head>${DEMO_VIDEO_CSP}</head>${stripped}`;
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

/**
 * Builds a POST handler shared by both routes: read+parse the body, validate
 * against `schema`, resolve cwd, run `validate(html)`, optionally `transform`
 * the html (CSP injection), then write it atomically as writer 'project-home'.
 */
function makeWriteHandler({ schema, maxBytes, validate, transform, targetPath }) {
  return async (req, res) => {
    // Allow headroom over maxBytes for JSON escaping; the html byte limit
    // itself is enforced by `validate` below.
    let raw;
    try {
      raw = await readBody(req, maxBytes * 2 + 4096);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'} (html limit is ${maxBytes} bytes)` });
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
      input = schema.parse(body);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid payload', details: e?.issues ?? e?.message });
      return;
    }
    const resolved = resolveCwd(input.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    const rejection = validate(input.html);
    if (rejection) {
      sendJson(res, 400, { ok: false, error: rejection });
      return;
    }
    // Only a route that is actually about to write widens config.cjs's
    // write boundary to this project root.
    config.addAllowedRoot(resolved.cwd);
    const finalHtml = transform ? transform(input.html) : input.html;
    try {
      const abs = targetPath(resolved.cwd);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await config.writeTextAtomic(abs, finalHtml, { writer: 'project-home' });
      sendJson(res, 200, { ok: true, path: abs, bytes: Buffer.byteLength(finalHtml, 'utf8') });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'write failed' });
    }
  };
}

function registerAdminRoute(adminHttp) {
  // POST /admin/project-home/write {cwd, html}
  adminHttp.registerRoute('POST', '/admin/project-home/write', makeWriteHandler({
    schema: schemas.projectHomeAdminWriteBody,
    maxBytes: MAX_HTML_BYTES,
    validate: validateHomeHtml,
    targetPath: (cwd) => opsPath(cwd, 'project-pages', 'home.html'),
  }));

  // POST /admin/project-home/demo-video/write {cwd, html}
  adminHttp.registerRoute('POST', '/admin/project-home/demo-video/write', makeWriteHandler({
    schema: schemas.projectDemoVideoAdminWriteBody,
    maxBytes: MAX_DEMO_VIDEO_BYTES,
    validate: validateDemoVideoHtml,
    transform: injectCsp,
    targetPath: (cwd) => opsPath(cwd, 'project-pages', 'demo-video', 'index.html'),
  }));
}

module.exports = {
  registerAdminRoute,
  validateHomeHtml,
  validateDemoVideoHtml,
  injectCsp,
  DEMO_VIDEO_CSP,
  MAX_HTML_BYTES,
  MAX_DEMO_VIDEO_BYTES,
};
