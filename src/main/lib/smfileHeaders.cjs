'use strict';

const DEMO_VIDEO_CSP_HEADER = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const DEMO_VIDEO_PATH_MARKER = '/session-manager-operations/project-pages/demo-video/';

/**
 * Response headers for a file served over the smfile:// protocol. A file
 * under the demo-video project-pages folder gets a CSP response header —
 * document content (a decoy <head>, HTML comments) cannot override this,
 * unlike the meta-tag CSP the demo-video HTML ships inline.
 * @param {string} realPath
 * @param {string} contentType
 */
function smfileResponseHeaders(realPath, contentType) {
  const normalised = String(realPath).replace(/\\/g, '/');
  const headers = { 'content-type': contentType };
  if (normalised.includes(DEMO_VIDEO_PATH_MARKER)) {
    headers['content-security-policy'] = DEMO_VIDEO_CSP_HEADER;
  }
  return headers;
}

/**
 * Guards against a demo-video document exfiltrating data by navigating its
 * own sandboxed iframe (meta refresh, `location.href = 'https://…'`), which
 * the CSP response header does not govern — `frame-src`/`connect-src` don't
 * stop a top-level navigation of the subframe itself.
 * @param {{ isMainFrame: boolean, currentUrl: string, targetUrl: string }} params
 * @returns {boolean}
 */
function shouldBlockFrameNavigation({ isMainFrame, currentUrl, targetUrl }) {
  if (isMainFrame) return false;
  if (typeof currentUrl !== 'string' || !currentUrl.startsWith('smfile:')) return false;

  let pathname;
  try {
    // Same normalisation as smfileResponseHeaders below: on Windows the
    // absolute path (and therefore the smfile:// URL built from it) uses
    // backslashes, which the forward-slash DEMO_VIDEO_PATH_MARKER would
    // otherwise never match — silently disabling this guard on win32.
    pathname = decodeURIComponent(new URL(currentUrl).pathname).replace(/\\/g, '/');
  } catch {
    return false;
  }
  if (!pathname.includes(DEMO_VIDEO_PATH_MARKER)) return false;

  if (typeof targetUrl !== 'string') return false;
  if (targetUrl.startsWith('smfile:')) return false;
  if (targetUrl === 'about:blank' || targetUrl === 'about:srcdoc') return false;
  return true;
}

module.exports = { DEMO_VIDEO_CSP_HEADER, smfileResponseHeaders, shouldBlockFrameNavigation };
