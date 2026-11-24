/**
 * projectHomeAdminRoutes.cjs — admin routes behind Project Home's library:
 *   POST /admin/project-home/pages/write        -> project-pages/knowledge/<pageId>/{index.html,meta.json}
 *   POST /admin/project-home/videos/write       -> project-pages/videos/<videoId>/{index.html,meta.json}
 *     (+ video.mp4 and poster.png, required for kind 'tiktok' / 'marketing')
 *   POST /admin/project-home/write              alias: {cwd, html} -> knowledge/overview/
 *   POST /admin/project-home/demo-video/write   alias: {cwd, html} -> a new videos/vid-<id>/ project-demo entry
 *   POST /admin/project-home/matrix/read        {cwd} -> project-pages/matrix/matrix.json (+ its JSON Schema)
 *   POST /admin/project-home/matrix/write       {cwd, matrix, model?} -> matrixStore.writeMatrix
 *   POST /admin/project-home/videos/review/write {cwd, videoId, text, images:[{base64}]} -> videoReview.writeMaterial
 *     (review material only; there is deliberately no route that decides, approves or retries —
 *     only the human buttons in the app record a decision)
 *   POST /admin/project-home/videos/outcome/write {cwd, videoId, outcome, text} -> videos/<videoId>/outcome.json
 *     (a run that ends without a video by design, e.g. a finished TikTok series: outcome 'season-complete')
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
const { opsPath, OPS_ROOT_DIR, assertOpsWrite } = require('../opsOwnership.cjs');
const config = require('../../config.cjs');
const { schemas, ENTRY_ID_RE } = require('../../ipcSchemas.cjs');
const { validateCharacterJson, validateCharacterJs, voiceIdRefsOf, inspectCharacter, characterDir, MAX_JSON_BYTES: MAX_CHARACTER_JSON_BYTES, MAX_JS_BYTES: MAX_CHARACTER_JS_BYTES } = require('../demo-video-kit/character.cjs');
const voiceLibrary = require('../demo-video-kit/voiceLibrary.cjs');
const projectSounds = require('../demo-video-kit/projectSounds.cjs');
const { checkHtmlLimits, checkPostCaption, TIKTOK_CHECK_IDS } = require('../demo-video-kit/checks.cjs');
const { injectPlayerBridge } = require('../project-pages/playerBridge.cjs');
const { readMatrix, matrixJsonSchema, MAX_MATRIX_BYTES } = require('../project-pages/competitiveMatrix.cjs');
const { writeMatrix } = require('../project-pages/matrixStore.cjs');
const videoReview = require('../project-pages/videoReview.cjs');

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_DEMO_VIDEO_BYTES = 2 * 1024 * 1024;
/** Exported MP4 cap: 24 MiB per started 30 s of lengthS. */
const MAX_EXPORT_MP4_BYTES_PER_30S = 24 * 1024 * 1024;
const MAX_EXPORT_POSTER_BYTES = 4 * 1024 * 1024;
/** Kinds whose save must carry an MP4 + poster export, and the aspect each requires. */
const EXPORT_KIND_ASPECT = Object.freeze({ tiktok: '9:16', marketing: '16:9' });
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Review write body cap: 6 base64 images of 2 MiB (16 MiB) + a 32000-char text and JSON overhead. */
const REVIEW_WRITE_BODY_MAX = 18 * 1024 * 1024;
const REVIEW_DECISION_KEYS = Object.freeze(['decision', 'status', 'approved', 'approvedAt']);
const REVIEW_DECISION_REFUSAL = 'review decisions are made only by a human in the app';
/** Outcomes a run may record instead of a video, the outcome text cap, and the only body keys accepted. */
const VIDEO_OUTCOMES = ['season-complete'];
const OUTCOME_TEXT_MAX = 300;
const OUTCOME_BODY_KEYS = ['cwd', 'videoId', 'outcome', 'text'];
const OUTCOME_WRITE_BODY_MAX = 64 * 1024;
/** Character write body cap: js + json, every project sound WAV as base64, and 128 KiB of overhead. */
const CHARACTER_WRITE_BODY_MAX = MAX_CHARACTER_JS_BYTES * 2 + base64LengthFor(projectSounds.MAX_SOUNDS_TOTAL_BYTES) + 128 * 1024;

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

// <meta name="sm-demo-aspect" content="..."> in any attribute order, either quote style.
const META_TAG_RE = /<meta\b[^>]*>/gi;
const ASPECT_NAME_RE = /\bname\s*=\s*(["'])\s*sm-demo-aspect\s*\1/i;
const CONTENT_ATTR_RE = /\bcontent\s*=\s*(["'])(.*?)\1/i;
const VIDEO_ASPECTS = ['16:9', '9:16'];

/** The document's declared aspect: '16:9' when no tag, an error for any other value. */
function readAspect(html) {
  for (const tag of html.match(META_TAG_RE) ?? []) {
    if (!ASPECT_NAME_RE.test(tag)) continue;
    const content = (tag.match(CONTENT_ATTR_RE)?.[2] ?? '').trim();
    if (VIDEO_ASPECTS.includes(content)) return { aspect: content };
    return { error: `sm-demo-aspect content must be '16:9' or '9:16' (got '${content.slice(0, 40)}')` };
  }
  return { aspect: '16:9' };
}

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
function makeWriteHandler({ schema, bodyLimit, extraBodyBytes = 0, build }) {
  return async (req, res) => {
    // Headroom over the html limit for JSON escaping; the html byte limit
    // itself is enforced by `build`. `extraBodyBytes` makes room for base64
    // binary exports, whose decoded caps `build` enforces too.
    let raw;
    try {
      raw = await readBody(req, bodyLimit * 2 + extraBodyBytes + 4096);
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
      // Binary exports first, then index.html, then meta.json last: meta.json marks a complete entry.
      for (const file of built.files ?? []) {
        await config.writeBinaryAtomic(path.join(dir, file.name), file.buffer, { writer: 'project-home' });
      }
      const abs = path.join(dir, 'index.html');
      await config.writeTextAtomic(abs, built.html, { writer: 'project-home' });
      await config.writeTextAtomic(path.join(dir, 'meta.json'), JSON.stringify(built.meta, null, 2) + '\n', { writer: 'project-home' });
      sendJson(res, 200, { ok: true, path: abs, bytes: Buffer.byteLength(built.html, 'utf8'), id: built.meta.id, meta: built.meta });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'write failed' });
    }
  };
}

/** Size cap for a video of `lengthS` seconds: 2 MiB per started 30 s. */
function maxVideoBytes(lengthS) {
  return Math.ceil(lengthS / 30) * MAX_DEMO_VIDEO_BYTES;
}

/** Exported MP4 cap for a video of `lengthS` seconds: 24 MiB per started 30 s. */
function maxExportMp4Bytes(lengthS) {
  return Math.ceil(lengthS / 30) * MAX_EXPORT_MP4_BYTES_PER_30S;
}

/** Base64 length that decodes to at most `bytes` bytes. */
function base64LengthFor(bytes) {
  return Math.ceil(bytes / 3) * 4;
}

/** Decodes one base64 export under `maxBytes`; -> {buffer} | {error}. Errors never echo the payload. */
function decodeExport(b64, label, maxBytes) {
  if (b64.length > base64LengthFor(maxBytes)) return { error: `exports.${label} exceeds the ${maxBytes}-byte limit` };
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return { error: `exports.${label} is not valid base64` };
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > maxBytes) return { error: `exports.${label} exceeds the ${maxBytes}-byte limit` };
  return { buffer };
}

/**
 * Rules for kinds that must ship an MP4 + poster ('tiktok', 'marketing'):
 * both exports present, magic bytes, size caps, the kind's aspect, and for
 * 'tiktok' the post caption and every TikTok check passing.
 * -> {files: [{name, buffer}]} | {error}.
 */
function validateExportKind(input, aspect) {
  const { kind, lengthS } = input;
  const exp = input.exports;
  if (!exp || !exp.mp4Base64 || !exp.posterBase64) {
    return { error: `kind '${kind}' requires exports.mp4Base64 and exports.posterBase64 (the MP4 and poster)` };
  }
  const mp4 = decodeExport(exp.mp4Base64, 'mp4Base64', maxExportMp4Bytes(lengthS));
  if (mp4.error) return { error: `${mp4.error} (24 MiB per started 30 s of lengthS ${lengthS})` };
  if (mp4.buffer.length < 8 || mp4.buffer.toString('latin1', 4, 8) !== 'ftyp') {
    return { error: "exports.mp4Base64 is not an MP4 (no 'ftyp' at bytes 4-7)" };
  }
  const poster = decodeExport(exp.posterBase64, 'posterBase64', MAX_EXPORT_POSTER_BYTES);
  if (poster.error) return { error: poster.error };
  if (poster.buffer.length < PNG_SIGNATURE.length || !poster.buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { error: 'exports.posterBase64 is not a PNG (missing the PNG signature)' };
  }
  const wantAspect = EXPORT_KIND_ASPECT[kind];
  if (aspect !== wantAspect) {
    return { error: `kind '${kind}' requires aspect '${wantAspect}' (the document declares '${aspect}' via sm-demo-aspect)` };
  }
  if (kind === 'tiktok') {
    const post = input.meta?.post;
    if (!post) return { error: "kind 'tiktok' requires meta.post {caption, audience}" };
    const caption = checkPostCaption(post.caption);
    if (!caption.ok) return { error: `kind 'tiktok' post caption check failed: ${caption.detail}` };
    const checks = input.meta?.report?.checks ?? [];
    const missing = TIKTOK_CHECK_IDS.filter((id) => !checks.some((c) => c.id === id && c.ok === true));
    if (missing.length) return { error: `kind 'tiktok' requires every TikTok check in meta.report.checks with ok true; missing or failed: ${missing.join(', ')}` };
  }
  return { files: [{ name: 'video.mp4', buffer: mp4.buffer }, { name: 'poster.png', buffer: poster.buffer }] };
}

// Owned by the Competitor matrix store (project-pages/matrixStore.cjs writes
// knowledge/<id>/ directly). Kept local on purpose; macroJobDispatch.cjs holds
// the same constant so the builder never derives this id.
const MATRIX_PAGE_ID = 'competitive-matrix';

function buildPage(input, { pageId, title, topic }) {
  if (!ENTRY_ID_RE.test(pageId)) return { error: 'invalid pageId' };
  if (pageId === MATRIX_PAGE_ID) return { error: `pageId '${MATRIX_PAGE_ID}' is reserved for the Competitor matrix (written by project_matrix_write)` };
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
  // The document's tag is the one source; a caller-supplied meta.aspect is ignored.
  const declaredAspect = readAspect(input.html);
  if (declaredAspect.error) return { error: declaredAspect.error };
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
      aspect: declaredAspect.aspect,
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
    extraBodyBytes: base64LengthFor(maxExportMp4Bytes(MAX_DEMO_DURATION_S)) + base64LengthFor(MAX_EXPORT_POSTER_BYTES),
    build: (i) => {
      // Cheap kit checks re-run server-side; the alias route is exempt (Burrow sends no report).
      const failed = (i.meta?.report?.checks ?? []).find((c) => c.ok === false);
      if (failed) return { error: `report.checks failed: ${failed.id}${failed.detail ? ` (${failed.detail})` : ''}` };
      const limits = checkHtmlLimits({ html: i.html, lengthS: i.lengthS });
      if (!limits.ok) return { error: `${limits.id} check failed: ${limits.detail}` };
      const built = buildVideo(i, i);
      // Other kinds ignore any exports, exactly as before.
      if (built.error || !Object.hasOwn(EXPORT_KIND_ASPECT, i.kind)) return built;
      const exported = validateExportKind(i, built.meta.aspect ?? '16:9');
      if (exported.error) return { error: exported.error };
      return { ...built, files: exported.files };
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

  // POST /admin/project-home/videos/review/write {cwd, videoId, text, images:[{base64}]} -> review/material.json
  adminHttp.registerRoute('POST', '/admin/project-home/videos/review/write', reviewWriteHandler);

  // POST /admin/project-home/videos/outcome/write {cwd, videoId, outcome, text} -> videos/<videoId>/outcome.json
  adminHttp.registerRoute('POST', '/admin/project-home/videos/outcome/write', outcomeWriteHandler);

  // POST /admin/project-home/character/write {cwd, json, js, replace?, sounds?} -> videos/_character/
  // (sounds = { <name>: <base64 WAV> } for every file-backed sound, written to sounds/<name>.wav;
  // answers {ok, path, bytes, sounds: <names written>})
  adminHttp.registerRoute('POST', '/admin/project-home/character/write', characterWriteHandler);

  // POST /admin/project-home/matrix/read {cwd?} -> {ok, matrix|null, error, path, schema}
  adminHttp.registerRoute('POST', '/admin/project-home/matrix/read', makeMatrixHandler(async (cwd) => {
    const r = await readMatrix(cwd);
    return { status: 200, body: { ok: true, matrix: r.matrix, error: r.error, path: r.path, schema: matrixJsonSchema() } };
  }));

  // POST /admin/project-home/matrix/write {cwd?, matrix, model?} -> writeMatrix's result
  adminHttp.registerRoute('POST', '/admin/project-home/matrix/write', makeMatrixHandler(async (cwd, body) => {
    if (body.model !== undefined && typeof body.model !== 'string') {
      return { status: 400, body: { ok: false, error: 'model must be a string' } };
    }
    config.addAllowedRoot(cwd);
    const r = await writeMatrix(cwd, body.matrix, { model: body.model ?? '' });
    return { status: r.ok ? 200 : 400, body: r };
  }));
}

/** JSON body (capped at MAX_MATRIX_BYTES + 64 KB) + resolveCwd, then `run(cwd, body)` -> {status, body}. */
function makeMatrixHandler(run) {
  return async (req, res) => {
    let raw;
    try {
      raw = await readBody(req, MAX_MATRIX_BYTES + 64 * 1024);
    } catch (e) {
      sendJson(res, 413, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'} (matrix limit is ${MAX_MATRIX_BYTES} bytes)` });
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
    try {
      const out = await run(resolved.cwd, body);
      sendJson(res, out.status, out.body);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'matrix route failed' });
    }
  };
}

/**
 * Saves review material for one review-stage video entry. Never records a
 * decision: a body carrying any decision-shaped key is refused outright.
 */
async function reviewWriteHandler(req, res) {
  let raw;
  try {
    raw = await readBody(req, REVIEW_WRITE_BODY_MAX);
  } catch (e) {
    sendJson(res, 413, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'} (limit is ${REVIEW_WRITE_BODY_MAX} bytes)` });
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
  if (REVIEW_DECISION_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
    sendJson(res, 400, { ok: false, error: REVIEW_DECISION_REFUSAL });
    return;
  }
  const { videoId, text, images } = body;
  if (typeof videoId !== 'string' || !ENTRY_ID_RE.test(videoId)) {
    sendJson(res, 400, { ok: false, error: 'invalid videoId' });
    return;
  }
  if (!Array.isArray(images)) {
    sendJson(res, 400, { ok: false, error: 'images must be an array of { base64 }' });
    return;
  }
  const decoded = [];
  for (let i = 0; i < images.length; i++) {
    const b64 = images[i] && images[i].base64;
    if (typeof b64 !== 'string' || !b64) {
      sendJson(res, 400, { ok: false, error: `image ${i + 1}: base64 must be a non-empty string` });
      return;
    }
    decoded.push({ bytes: Buffer.from(b64, 'base64') });
  }
  const resolved = resolveCwd(body.cwd);
  if (!resolved.ok) {
    sendJson(res, resolved.status, { ok: false, error: resolved.error });
    return;
  }
  config.addAllowedRoot(resolved.cwd);
  try {
    const r = await videoReview.writeMaterial(resolved.cwd, videoId, { text, images: decoded });
    if (!r.ok) {
      sendJson(res, 400, { ok: false, error: r.error });
      return;
    }
    const review = await videoReview.readReview(resolved.cwd, videoId);
    sendJson(res, 200, { ok: true, entryId: videoId, status: review ? review.status : 'waiting' });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message ?? 'review write failed' });
  }
}

/** Returns a refusal reason for an outcome body, or null when it is valid. */
function validateOutcomeBody(body) {
  const unknown = Object.keys(body).filter((k) => !OUTCOME_BODY_KEYS.includes(k));
  if (unknown.length) return `unknown body keys: ${unknown.join(', ')} (allowed: ${OUTCOME_BODY_KEYS.join(', ')})`;
  if (typeof body.videoId !== 'string' || !ENTRY_ID_RE.test(body.videoId)) return 'invalid videoId';
  if (!VIDEO_OUTCOMES.includes(body.outcome)) return `outcome must be one of: ${VIDEO_OUTCOMES.join(', ')}`;
  const { text } = body;
  if (typeof text !== 'string' || !text.trim()) return 'text must be a non-empty string';
  if (/[\r\n]/.test(text)) return 'text must be one line';
  if (text.length > OUTCOME_TEXT_MAX) return `text must be at most ${OUTCOME_TEXT_MAX} characters`;
  return null;
}

/**
 * Records that a video entry ended without a video by design (a finished
 * TikTok series): writes videos/<videoId>/outcome.json = {id, outcome, text, at}.
 * Refused when the entry already has its video (index.html).
 */
async function outcomeWriteHandler(req, res) {
  let raw;
  try {
    raw = await readBody(req, OUTCOME_WRITE_BODY_MAX);
  } catch (e) {
    sendJson(res, 413, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'} (limit is ${OUTCOME_WRITE_BODY_MAX} bytes)` });
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
  const invalid = validateOutcomeBody(body);
  if (invalid) {
    sendJson(res, 400, { ok: false, error: invalid });
    return;
  }
  const resolved = resolveCwd(body.cwd);
  if (!resolved.ok) {
    sendJson(res, resolved.status, { ok: false, error: resolved.error });
    return;
  }
  const { videoId, outcome, text } = body;
  const dir = opsPath(resolved.cwd, 'project-pages', 'videos', videoId);
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    sendJson(res, 400, { ok: false, error: `entry ${videoId} already has a video (index.html) — an outcome is only for a run that ends without one` });
    return;
  }
  config.addAllowedRoot(resolved.cwd);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const abs = opsPath(resolved.cwd, 'project-pages', 'videos', videoId, 'outcome.json');
    const record = { id: videoId, outcome, text, at: new Date().toISOString() };
    await config.writeTextAtomic(abs, JSON.stringify(record, null, 2) + '\n', { writer: 'project-home' });
    sendJson(res, 200, { ok: true, entryId: videoId, path: abs });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message ?? 'outcome write failed' });
  }
}

/**
 * Checks a character write's `sounds` payload ({ <name>: <base64 WAV> }) against the
 * file-backed sounds `jsonObj` declares: exactly one entry per name, valid base64, each
 * WAV within its kind's cap and readable, and the total within MAX_SOUNDS_TOTAL_BYTES.
 * -> {files: [{name, buffer}]} | {error}. Errors never echo the payload.
 */
function checkSoundPayload(jsonObj, sounds) {
  const payload = sounds === undefined || sounds === null ? {} : sounds;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'sounds payload must be an object of { name: base64 WAV }' };
  }
  const names = projectSounds.fileBackedSoundNames(jsonObj);
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(payload, name)) {
      return { error: `sound '${name}' has no WAV: send it as sounds.${name} (project_character_write soundPaths.${name})` };
    }
  }
  for (const key of Object.keys(payload)) {
    if (!names.includes(key)) return { error: `sound '${key}' was sent but character.json declares no file-backed sound by that name` };
  }
  const files = [];
  let total = 0;
  for (const name of names) {
    const b64 = payload[name];
    if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
      return { error: `sound '${name}' is not valid base64` };
    }
    const kind = projectSounds.findProjectSound(jsonObj, name).kind;
    const cap = kind === 'sfx' ? projectSounds.MAX_SFX_WAV_BYTES : projectSounds.MAX_BED_WAV_BYTES;
    const label = `sound '${name}'`;
    if (b64.length > base64LengthFor(cap)) {
      return { error: `${label} is over the ${cap}-byte limit for a ${kind === 'sfx' ? 'sound effect' : 'music bed'}` };
    }
    const buffer = Buffer.from(b64, 'base64');
    const wavErr = projectSounds.checkSoundWav(buffer, label, kind);
    if (wavErr) return { error: wavErr };
    total += buffer.length;
    files.push({ name, buffer });
  }
  if (total > projectSounds.MAX_SOUNDS_TOTAL_BYTES) {
    return { error: `sounds total ${total} bytes exceed the ${projectSounds.MAX_SOUNDS_TOTAL_BYTES}-byte limit` };
  }
  return { files };
}

/** Removes every entry of soundsDir(cwd) that is not a declared <name>.wav; removes the folder when nothing is declared. */
async function pruneSounds(cwd, names) {
  const dir = projectSounds.soundsDir(cwd);
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
  const keep = new Set(names.map((n) => `${n}.wav`));
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    const abs = path.join(dir, entry);
    assertOpsWrite(abs, 'project-home');
    await fs.promises.rm(abs, { recursive: true, force: true });
  }
  if (names.length === 0) {
    assertOpsWrite(dir, 'project-home');
    await fs.promises.rmdir(dir);
  }
}

async function characterWriteHandler(req, res) {
  let raw;
  try {
    raw = await readBody(req, CHARACTER_WRITE_BODY_MAX);
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
  // A {voiceId} voice must name a library voice this project can use (unknown or
  // tampered-approved ids are refused by voiceLibrary's own reason) before anything is written.
  for (const ref of voiceIdRefsOf(jsonObj)) {
    const r = voiceLibrary.resolveVoiceId(resolved.cwd, ref.voiceId);
    if (!r.ok) {
      sendJson(res, 400, { ok: false, error: r.error });
      return;
    }
  }
  const jsonText = JSON.stringify(jsonObj, null, 2) + '\n';
  const jsonBytes = Buffer.byteLength(jsonText, 'utf8');
  if (jsonBytes > MAX_CHARACTER_JSON_BYTES) {
    sendJson(res, 400, { ok: false, error: `character.json exceeds the ${MAX_CHARACTER_JSON_BYTES}-byte limit (${jsonBytes} bytes as saved)` });
    return;
  }
  const soundPayload = checkSoundPayload(jsonObj, body.sounds);
  if (soundPayload.error) {
    sendJson(res, 400, { ok: false, error: `character.json invalid: ${soundPayload.error}` });
    return;
  }
  const jsErr = validateCharacterJs(body.js, [...REMOTE_REFERENCE_CHECKS, ...NETWORK_CHECKS]);
  if (jsErr) {
    sendJson(res, 400, { ok: false, error: jsErr });
    return;
  }
  if (!body.replace) {
    const existing = inspectCharacter(resolved.cwd);
    if (existing.ok) {
      sendJson(res, 409, { ok: false, error: 'a character already exists — pass replace: true to overwrite it' });
      return;
    }
    if (existing.exists) {
      sendJson(res, 409, { ok: false, error: `a character already exists but cannot be used (${existing.error}) — fix it, or pass replace: true to overwrite it` });
      return;
    }
  }
  config.addAllowedRoot(resolved.cwd);
  try {
    const dir = characterDir(resolved.cwd);
    await fs.promises.mkdir(dir, { recursive: true });
    for (const f of soundPayload.files) {
      await config.writeBinaryAtomic(projectSounds.soundFile(resolved.cwd, f.name), f.buffer, { writer: 'project-home' });
    }
    const jsPath = path.join(dir, 'character.js');
    await config.writeTextAtomic(jsPath, body.js, { writer: 'project-home' });
    await config.writeTextAtomic(path.join(dir, 'character.json'), jsonText, { writer: 'project-home' });
    await pruneSounds(resolved.cwd, soundPayload.files.map((f) => f.name));
    sendJson(res, 200, { ok: true, path: dir, bytes: Buffer.byteLength(body.js, 'utf8'), sounds: soundPayload.files.map((f) => f.name) });
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
  maxExportMp4Bytes,
  MAX_EXPORT_POSTER_BYTES,
  DEMO_VIDEO_CSP,
  MAX_HTML_BYTES,
  MAX_DEMO_VIDEO_BYTES,
  REVIEW_WRITE_BODY_MAX,
  VIDEO_OUTCOMES,
  OUTCOME_TEXT_MAX,
  resolveCwd,
};
