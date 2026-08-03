#!/usr/bin/env node
/**
 * mint-epic.cjs — CLI wrapper over lib/epicMint.cjs's JOIN path, for PRD
 * authors working without the app's admin API (the /develop skill's
 * manual-write fallback).
 *
 * This script never creates an Epic. It only resolves an EXISTING Epic's
 * prds/ write directory. An Epic comes into existence in exactly one place —
 * the human pressing New Epic in the app (epicMint.cjs's SINGLE-CREATOR LAW)
 * — never implicitly from a PRD-authoring path. /develop must already be
 * running inside that Epic's own conversation (or have its id in hand)
 * before it calls this.
 *
 * Usage:
 *   node scripts/mint-epic.cjs <cwd> <epic-id>
 *
 * Prints the Epic's prds/ write directory on stdout (last line). Exits 1
 * with no stdout output if <epic-id> does not exist in
 * <cwd>/session-manager-operations/prompt-sessions/active-index.json.
 */
'use strict';

const { ensureEpic } = require('../src/main/lib/epicMint.cjs');

const [cwd, epicId] = process.argv.slice(2);
if (!cwd || !epicId) {
  process.stderr.write('usage: mint-epic.cjs <cwd> <epic-id>\n');
  process.stderr.write('(epic-id must already exist — this script only joins, never creates)\n');
  process.exit(1);
}

(async () => {
  try {
    const { prdDir } = await ensureEpic(cwd, { epicId });
    process.stderr.write(`joined epic ${epicId}\n`);
    process.stdout.write(`${prdDir}\n`);
  } catch (e) {
    process.stderr.write(`${e?.message ?? 'no such Epic'}\n`);
    process.exit(1);
  }
})();
