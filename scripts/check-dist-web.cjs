'use strict';

/** Release check: fails when dist-web/index.html references a file the desktop cannot serve. */

const { missingEntryFiles } = require('../src/main/lib/feedback-remote/remoteAssets.cjs');

const missing = missingEntryFiles();
if (missing.length === 0) {
  console.log('check-dist-web: OK — every index.html reference is servable');
  process.exit(0);
}
for (const name of missing) console.error(`check-dist-web: not servable: ${name}`);
process.exit(1);
