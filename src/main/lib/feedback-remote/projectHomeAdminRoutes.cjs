/**
 * projectHomeAdminRoutes.cjs — admin routes behind Project Home's library:
 *   POST /admin/project-home/pages/write        -> project-pages/knowledge/<pageId>/{index.html,meta.json}
 *   POST /admin/project-home/videos/write       -> project-pages/videos/<videoId>/{index.html,meta.json}
 *   POST /admin/project-home/write              alias: {cwd, html} -> knowledge/overview/
 *   POST /admin/project-home/demo-video/write   alias: {cwd, html} -> a new videos/vid-<id>/ project-demo entry
 * all owned by writer 'project-home' (see opsOwnership.cjs). Registered
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
const crypto = require('node:crypto');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { resolveProjectContext } = require('../projectRootResolve.cjs');
const { opsPath, OPS_ROOT_DIR } = require('../opsOwnership.cjs');
const config = require('../../config.cjs');
const { schemas, ENTRY_ID_RE } = require('../../ipcSchemas.cjs');
const { validateCharacterJson, validateCharacterJs, readCharacter, characterDir, MAX_JS_BYTES: MAX_CHARACTER_JS_BYTES } = require('../demo-video-kit/character.cjs');
const { checkHtmlLimits } = require('../demo-video-kit/checks.cjs');
const { injectPlayerBridge } = require('../project-pages/playerBridge.cjs');

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
  { re: /["'`](?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|open|importScripts)["'`]/i, message: 'computed/bracket access to a network API (e.g. window["fetch"]) is not allowed' },
  { re: /\bWorker\s*\(/i, message: 'Worker(...) is not allowed' },
  { re: /\bSharedWorker\b/i, message: 'SharedWorker is not allowed' },
  { re: /\bserviceWorker\b/i, message: 'serviceWorker is not allowed' },
  { re: /rel\s*=\s*["']?\s*(?:prefetch|preconnect|dns-prefetch|preload)/i, message: 'rel="prefetch|preconnect|dns-prefetch|preload" is not allowed' },
  { re: /\beval\s*\(/i, message: 'eval(...) is not allowed' },
  { re: /\bFunction\s*\(/i, message: 'Function(...) is not allowed' },
  { re: /<base\b/i, message: '<base> is not allowed' },
  { re: /<form\b/i, message: '<form> is not allowed' },
  { re: /http-equiv\s*=\s*["']?refresh/i, message: 'meta refresh is not allowed' },
  { re: /\blocation\s*(?:\.\s*(?:href|assign|replace)\b|=[^=])/i, message: 'location.href/assign/replace/= navigation is not allowed' },
  { re: /\bdocument\.location\b/i, message: 'document.location is not allowed' },
  { re: /\b(?:top|parent)\./i, message: 'top./parent. property access is not allowed' },
  { re: /<a\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)/i, message: '<a href="http(s):|//|javascript:…"> is not allowed' },
];

const DURATION_META_RE = /<meta\b[^>]*\bname\s*=\s*["']sm-demo-duration["'][^>]*\bcontent\s*=\s*["'](\d+)["'][^>]*>/i;
const MIN_DEMO_DURATION_S = 5;
const MAX_DEMO_DURATION_S = 60;

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
function validateDemoVideoHtml(html, maxBytes = MAX_DEMO_VIDEO_BYTES) {
  if (typeof html !== 'string' || html.trim().length === 0) return 'html must be a non-empty string';
  if (Buffer.byteLength(html, 'utf8') > maxBytes) return `html exceeds the ${maxBytes}-byte limit`;
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
 * Strips any existing CSP meta and a leading doctype, then returns the CSP
 * as the very first element after a fresh `<!DOCTYPE html>` — a position no
 * decoy `<head` text, HTML comment, or string literal in the document can
 * influence. The HTML parser folds a <meta> emitted right after the doctype
 * into the implicitly-created <head>, and a later <html>/<head> start tag is
 * merged/ignored, so the CSP still applies to the whole document.
 */
function injectCsp(html) {
  const withoutCsp = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>\s*/gi, '');
  const withoutDoctype = withoutCsp.replace(/^\s*<!DOCTYPE\b[^>]*>\s*/i, '');
  return `<!DOCTYPE html>${DEMO_VIDEO_CSP}${withoutDoctype}`;
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
 * Builds a POST handler shared by every route: read+parse the body, validate
 * against `schema`, resolve cwd, then `build(input)` -> {error} | {dir, html,
 * meta}. The entry folder gets index.html then meta.json, both atomically as
 * writer 'project-home'. Responds {ok, path (index.html), bytes}.
 */
function makeWriteHandler({ schema, bodyLimit, build }) {
  return async (req, res) => {
    // Headroom over the html limit for JSON escaping; the html byte limit
    // itself is enforced by `build`.
    let raw;
    try {
      raw = await readBody(req, bodyLimit * 2 + 4096);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'} (html limit is ${bodyLimit} bytes)` });
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
    const built = build(input);
    if (built.error) {
      sendJson(res, 400, { ok: false, error: built.error });
      return;
    }
    // Only a route that is actually about to write widens config.cjs's
    // write boundary to this project root.
    config.addAllowedRoot(resolved.cwd);
    try {
      const dir = opsPath(resolved.cwd, 'project-pages', ...built.dirParts);
      await fs.promises.mkdir(dir, { recursive: true });
      const abs = path.join(dir, 'index.html');
      await config.writeTextAtomic(abs, built.html, { writer: 'project-home' });
      await config.writeTextAtomic(path.join(dir, 'meta.json'), JSON.stringify(built.meta, null, 2) + '\n', { writer: 'project-home' });
      sendJson(res, 200, { ok: true, path: abs, bytes: Buffer.byteLength(built.html, 'utf8'), id: built.meta.id });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'write failed' });
    }
  };
}

/** Size cap for a video of `lengthS` seconds: 2 MiB per started 30 s. */
function maxVideoBytes(lengthS) {
  return Math.ceil(lengthS / 30) * MAX_DEMO_VIDEO_BYTES;
}

function buildPage(input, { pageId, title, topic }) {
  if (!ENTRY_ID_RE.test(pageId)) return { error: 'invalid pageId' };
  const rejection = validateHomeHtml(input.html);
  if (rejection) return { error: rejection };
  return {
    dirParts: ['knowledge', pageId],
    html: input.html,
    meta: schemas.projectPageMeta.parse({ id: pageId, title, topic, createdAt: new Date().toISOString(), model: '' }),
  };
}

/** Shared video path. `meta` is the full video meta minus id/createdAt/report.bytes. */
function buildVideo(input, { videoId, title, kind, lengthS, meta }) {
  if (!ENTRY_ID_RE.test(videoId)) return { error: 'invalid videoId' };
  const cap = maxVideoBytes(lengthS);
  const rejection = validateDemoVideoHtml(input.html, cap);
  if (rejection) return { error: rejection };
  const declared = Number(input.html.match(DURATION_META_RE)[1]);
  if (declared !== lengthS) return { error: `sm-demo-duration (${declared}) must equal lengthS (${lengthS})` };
  const html = injectPlayerBridge(injectCsp(input.html));
  const bytes = Buffer.byteLength(html, 'utf8');
  return {
    dirParts: ['videos', videoId],
    html,
    meta: schemas.projectVideoMeta.parse({
      ...meta,
      id: videoId,
      title,
      kind,
      lengthS,
      createdAt: new Date().toISOString(),
      report: { ...meta.report, bytes },
    }),
  };
}

function newVideoId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(3);
  let rnd = '';
  for (const b of bytes) rnd += alphabet[b % alphabet.length];
  return `vid-${Date.now().toString(36)}${rnd}`;
}

function registerAdminRoute(adminHttp) {
  // POST /admin/project-home/pages/write {cwd, pageId, title, topic?, html}
  adminHttp.registerRoute('POST', '/admin/project-home/pages/write', makeWriteHandler({
    schema: schemas.projectPageAdminWriteBody,
    bodyLimit: MAX_HTML_BYTES,
    build: (i) => buildPage(i, { pageId: i.pageId, title: i.title, topic: i.topic ?? '' }),
  }));

  // POST /admin/project-home/videos/write {cwd, videoId, title, kind, lengthS, html, meta}
  adminHttp.registerRoute('POST', '/admin/project-home/videos/write', makeWriteHandler({
    schema: schemas.projectVideoAdminWriteBody,
    bodyLimit: maxVideoBytes(MAX_DEMO_DURATION_S),
    build: (i) => {
      // Cheap kit checks re-run server-side; the alias route is exempt (Burrow sends no report).
      const failed = (i.meta?.report?.checks ?? []).find((c) => c.ok === false);
      if (failed) return { error: `report.checks failed: ${failed.id}${failed.detail ? ` (${failed.detail})` : ''}` };
      const limits = checkHtmlLimits({ html: i.html, lengthS: i.lengthS });
      if (!limits.ok) return { error: `${limits.id} check failed: ${limits.detail}` };
      return buildVideo(i, i);
    },
  }));

  // Alias: POST /admin/project-home/write {cwd, html} -> knowledge/overview/
  adminHttp.registerRoute('POST', '/admin/project-home/write', makeWriteHandler({
    schema: schemas.projectHomeAdminWriteBody,
    bodyLimit: MAX_HTML_BYTES,
    build: (i) => buildPage(i, { pageId: 'overview', title: 'Overview', topic: 'overview' }),
  }));

  // Alias: POST /admin/project-home/demo-video/write {cwd, html} -> a NEW videos/vid-*/ entry
  adminHttp.registerRoute('POST', '/admin/project-home/demo-video/write', makeWriteHandler({
    schema: schemas.projectDemoVideoAdminWriteBody,
    bodyLimit: maxVideoBytes(MAX_DEMO_DURATION_S),
    build: (i) => {
      const rejection = validateDemoVideoHtml(i.html, maxVideoBytes(MAX_DEMO_DURATION_S));
      if (rejection) return { error: rejection };
      const lengthS = Number(i.html.match(DURATION_META_RE)[1]);
      return buildVideo(i, {
        videoId: newVideoId(),
        title: 'Demo video',
        kind: 'project-demo',
        lengthS,
        meta: {
          style: '',
          character: null,
          sources: [],
          report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [] },
          macroVersion: 0,
          seedVersion: 0,
          model: '',
          effort: '',
        },
      });
    },
  }));

  // POST /admin/project-home/character/write {cwd, json, js, replace?} -> videos/_character/
  adminHttp.registerRoute('POST', '/admin/project-home/character/write', characterWriteHandler);
}

async function characterWriteHandler(req, res) {
  let raw;
  try {
    raw = await readBody(req, MAX_CHARACTER_JS_BYTES * 2 + 64 * 1024);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'}` });
    return;
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: 'invalid payload' });
    return;
  }
  const resolved = resolveCwd(body.cwd);
  if (!resolved.ok) {
    sendJson(res, resolved.status, { ok: false, error: resolved.error });
    return;
  }
  const json = body.json;
  const jsonObj = typeof json === 'string' ? (() => { try { return JSON.parse(json); } catch { return null; } })() : json;
  const jsonErr = validateCharacterJson(jsonObj);
  if (jsonErr) {
    sendJson(res, 400, { ok: false, error: `character.json invalid: ${jsonErr}` });
    return;
  }
  const jsErr = validateCharacterJs(body.js, [...REMOTE_REFERENCE_CHECKS, ...NETWORK_CHECKS]);
  if (jsErr) {
    sendJson(res, 400, { ok: false, error: jsErr });
    return;
  }
  if (!body.replace && readCharacter(resolved.cwd)) {
    sendJson(res, 409, { ok: false, error: 'a character already exists — pass replace: true to overwrite it' });
    return;
  }
  config.addAllowedRoot(resolved.cwd);
  try {
    const dir = characterDir(resolved.cwd);
    await fs.promises.mkdir(dir, { recursive: true });
    const jsPath = path.join(dir, 'character.js');
    await config.writeTextAtomic(jsPath, body.js, { writer: 'project-home' });
    await config.writeTextAtomic(path.join(dir, 'character.json'), JSON.stringify(jsonObj, null, 2) + '\n', { writer: 'project-home' });
    sendJson(res, 200, { ok: true, path: dir, bytes: Buffer.byteLength(body.js, 'utf8') });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message ?? 'write failed' });
  }
}

module.exports = {
  registerAdminRoute,
  validateHomeHtml,
  validateDemoVideoHtml,
  injectCsp,
  maxVideoBytes,
  DEMO_VIDEO_CSP,
  MAX_HTML_BYTES,
  MAX_DEMO_VIDEO_BYTES,
  resolveCwd,
};
