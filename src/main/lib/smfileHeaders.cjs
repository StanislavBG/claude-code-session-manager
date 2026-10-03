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

module.exports = { DEMO_VIDEO_CSP_HEADER, smfileResponseHeaders };
