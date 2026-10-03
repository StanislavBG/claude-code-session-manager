'use strict';

// vitest globals (describe/it/expect) — same convention as atomicFs.test.cjs

const { DEMO_VIDEO_CSP_HEADER, smfileResponseHeaders } = require('../smfileHeaders.cjs');

describe('smfileResponseHeaders', () => {
  it('attaches the demo-video CSP header for a file under project-pages/demo-video', () => {
    const realPath = '/home/user/project/session-manager-operations/project-pages/demo-video/index.html';
    const headers = smfileResponseHeaders(realPath, 'text/html');
    expect(headers).toEqual({
      'content-type': 'text/html',
      'content-security-policy': DEMO_VIDEO_CSP_HEADER,
    });
  });

  it('does not attach a CSP header for home.html', () => {
    const realPath = '/home/user/project/session-manager-operations/project-pages/home.html';
    const headers = smfileResponseHeaders(realPath, 'text/html');
    expect(headers).toEqual({ 'content-type': 'text/html' });
  });

  it('does not attach a CSP header for an arbitrary file', () => {
    const realPath = '/home/user/project/notes.txt';
    const headers = smfileResponseHeaders(realPath, 'text/plain');
    expect(headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('does not attach a CSP header when "demo-video" appears outside the project-pages path', () => {
    const realPath = '/tmp/demo-video/x.html';
    const headers = smfileResponseHeaders(realPath, 'text/html');
    expect(headers).toEqual({ 'content-type': 'text/html' });
  });

  it('normalises Windows-style separators before matching', () => {
    const realPath = 'C:\\Users\\bilko\\project\\session-manager-operations\\project-pages\\demo-video\\index.html';
    const headers = smfileResponseHeaders(realPath, 'text/html');
    expect(headers).toEqual({
      'content-type': 'text/html',
      'content-security-policy': DEMO_VIDEO_CSP_HEADER,
    });
  });

  it('exports the expected CSP header string', () => {
    expect(DEMO_VIDEO_CSP_HEADER).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"
    );
  });
});
