'use strict';
// Shared real-browser setup for demo-video-kit tests. Not a test file (no `.test.` in the name),
// and never seeded (seedKit.cjs KIT_FILES lists kit files only).
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The vitest sandbox points HOME at a temp dir, which hides the browser cache Playwright keys off
 * HOME. Point Playwright at the real user's cache (passwd home, not $HOME) so the real-browser
 * cases run; they still skip cleanly when Playwright or its Chromium binary is absent.
 * Sets PLAYWRIGHT_BROWSERS_PATH only when unset and the folder exists. Never throws.
 */
function usePlaywrightCache() {
  try {
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
    const real = path.join(os.userInfo().homedir, '.cache', 'ms-playwright');
    if (fs.existsSync(real)) process.env.PLAYWRIGHT_BROWSERS_PATH = real;
  } catch { /* no passwd entry */ }
}

/** True when a Playwright package resolves from cwd and its Chromium binary exists. */
function havePlaywright() {
  for (const n of ['playwright', 'playwright-core']) {
    try {
      const pw = require(require.resolve(n, { paths: [process.cwd()] }));
      return fs.existsSync(pw.chromium.executablePath());
    } catch { /* next */ }
  }
  return false;
}

module.exports = { usePlaywrightCache, havePlaywright };
