'use strict';

// vitest globals (describe/it/expect) — same convention as atomicFs.test.cjs

const { DEMO_VIDEO_CSP_HEADER, smfileResponseHeaders, shouldBlockFrameNavigation } = require('../smfileHeaders.cjs');

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

describe('shouldBlockFrameNavigation', () => {
  const demoVideoUrl = 'smfile://local/home/user/project/session-manager-operations/project-pages/demo-video/index.html';
  const editorPreviewUrl = 'smfile://local/home/user/project/session-manager-operations/project-pages/some-other-doc.html';

  // Mirrors smfileUrl() in src/renderer/state/editor.ts, which only splits
  // on '/' — a Windows absolute path (backslash-separated) comes through as
  // a single percent-encoded segment, so the URL's pathname decodes back to
  // backslashes rather than forward slashes.
  const demoVideoUrlWindowsStyle = `smfile://local/${encodeURIComponent('C:\\Users\\user\\project\\session-manager-operations\\project-pages\\demo-video\\index.html')}`;

  it('blocks a demo-video subframe navigating to an external https target', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: false,
      currentUrl: demoVideoUrl,
      targetUrl: 'https://evil.example.com/exfil?data=secret',
    })).toBe(true);
  });

  it('allows a demo-video subframe navigating to another smfile:// target', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: false,
      currentUrl: demoVideoUrl,
      targetUrl: 'smfile://local/home/user/project/session-manager-operations/project-pages/demo-video/other.html',
    })).toBe(false);
  });

  it('never blocks a main-frame navigation', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: true,
      currentUrl: demoVideoUrl,
      targetUrl: 'https://evil.example.com/exfil',
    })).toBe(false);
  });

  it('does not block an editor-preview smfile subframe (non demo-video path)', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: false,
      currentUrl: editorPreviewUrl,
      targetUrl: 'https://evil.example.com/exfil',
    })).toBe(false);
  });

  it('blocks a demo-video subframe navigating to an about: target other than about:blank/about:srcdoc', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: false,
      currentUrl: demoVideoUrl,
      targetUrl: 'about:config',
    })).toBe(true);
  });

  it('allows a demo-video subframe navigating to about:blank', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: false,
      currentUrl: demoVideoUrl,
      targetUrl: 'about:blank',
    })).toBe(false);
  });

  it('allows a demo-video subframe navigating to about:srcdoc', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: false,
      currentUrl: demoVideoUrl,
      targetUrl: 'about:srcdoc',
    })).toBe(false);
  });

  it('blocks a demo-video subframe on a Windows-style (backslash) path navigating externally', () => {
    expect(shouldBlockFrameNavigation({
      isMainFrame: false,
      currentUrl: demoVideoUrlWindowsStyle,
      targetUrl: 'https://evil.example.com/exfil',
    })).toBe(true);
  });
});
