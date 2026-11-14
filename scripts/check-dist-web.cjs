'use strict';

/**
 * Release check: fails when dist-web/index.html references a file the desktop cannot serve, or a
 * stylesheet/font on another origin (the bilko.run iframe drops those and falls back to system fonts).
 */

const fs = require('node:fs');
const path = require('node:path');
const { missingEntryFiles, externalStyleRefs } = require('../src/main/lib/feedback-remote/remoteAssets.cjs');

const missing = missingEntryFiles();
let external = [];
try {
  external = externalStyleRefs(fs.readFileSync(path.join(__dirname, '..', 'dist-web', 'index.html'), 'utf8'));
} catch { /* absent index.html is already reported by missingEntryFiles */ }

if (missing.length === 0 && external.length === 0) {
  console.log('check-dist-web: OK — every index.html reference is servable and same-origin');
  process.exit(0);
}
for (const name of missing) console.error(`check-dist-web: not servable: ${name}`);
for (const url of external) console.error(`check-dist-web: external stylesheet/font (dropped in the iframe): ${url}`);
process.exit(1);
