#!/usr/bin/env node
/**
 * mint-epic.cjs — CLI wrapper over lib/epicMint.cjs for PRD authors working
 * without the app's admin API (the /develop skill's manual-write fallback).
 *
 * Usage:
 *   node scripts/mint-epic.cjs <cwd> "<goal text>" [feature|bug|discussion]
 *
 * Prints the Epic's prds/ write directory on stdout (last line), minting the
 * Epic (and registering it in prompt-sessions/active-index.json) if no active
 * Epic with the same goal text exists — reuse-by-goal, so re-running for the
 * same goal is idempotent and returns the same directory.
 */
'use strict';

const { ensureEpic } = require('../src/main/lib/epicMint.cjs');

const [cwd, goalText, tag] = process.argv.slice(2);
if (!cwd || !goalText) {
  process.stderr.write('usage: mint-epic.cjs <cwd> "<goal text>" [feature|bug|discussion]\n');
  process.exit(1);
}

const { epicId, prdDir, created } = ensureEpic(cwd, { goalText, tag, reuseByGoal: true });
process.stderr.write(`${created ? 'minted' : 'joined'} epic ${epicId}\n`);
process.stdout.write(`${prdDir}\n`);
