#!/usr/bin/env node
/**
 * purge-dry-run.cjs — read-only preview of a human Epic purge.
 *
 *   node scripts/purge-dry-run.cjs <cwd> <epicId>
 *
 * Prints the JSON of purgeEpic({ cwd, epicId, dryRun: true })
 * (src/main/lib/epic/epicPurge.cjs): every artifact a purge WOULD remove, by
 * kind, with counts. Deletes and writes nothing — no tombstone, no audit
 * record — so a validator can run it against a real completed Epic.
 *
 * It never performs a real purge: that stays the epic:purge IPC (a human press)
 * only, and purgeEpic refuses one without the IPC authority token anyway.
 *
 * Exit: 0 = dry run listed (possibly zero artifacts); 1 = refused (JSON still
 * printed); 2 = usage.
 */
'use strict';

const path = require('node:path');

async function main(argv) {
  const [cwdArg, epicId] = argv;
  if (!cwdArg || !epicId) {
    process.stderr.write('usage: node scripts/purge-dry-run.cjs <cwd> <epicId>\n');
    return 2;
  }
  const { purgeEpic } = require('../src/main/lib/epic/epicPurge.cjs');
  const res = await purgeEpic({ cwd: path.resolve(cwdArg), epicId, dryRun: true });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  return res.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`purge-dry-run: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
