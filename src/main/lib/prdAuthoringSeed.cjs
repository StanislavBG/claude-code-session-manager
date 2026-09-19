'use strict';
// Seed-when-the-stamp-differs for the bundled PRD_AUTHORING.md guide.
// Pure fs + injected writer so it is testable without an Electron app.

const fs = require('fs');

const STAMP_RE = /^<!--\s*PRD_AUTHORING\.md\s+(v\d+)\s*-->/;

/** Version stamp from line 1 of `text`, or null when absent. */
function readStamp(text) {
  const first = String(text).split(/\r?\n/, 1)[0];
  const m = STAMP_RE.exec(first);
  return m ? m[1] : null;
}

/** True when dest should be (re)written from src: missing/unstamped/differing stamp. */
function shouldSeed(srcText, destText) {
  if (destText == null) return true;
  const destStamp = readStamp(destText);
  return destStamp === null || destStamp !== readStamp(srcText);
}

/**
 * Overwrite `dest` with `src` when shouldSeed. `write(abs, text)` is the atomic
 * writer (config.writeTextAtomic). Resolves true when it wrote, false otherwise.
 */
async function seedAuthoringGuide({ src, dest, write }) {
  if (!fs.existsSync(src)) return false;
  const srcText = fs.readFileSync(src, 'utf8');
  const destText = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  if (!shouldSeed(srcText, destText)) return false;
  await write(dest, srcText);
  return true;
}

module.exports = { readStamp, shouldSeed, seedAuthoringGuide };
