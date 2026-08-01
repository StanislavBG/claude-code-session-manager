#!/usr/bin/env node
/**
 * propose-epic.cjs — file an Epic that does NOT start.
 *
 * This is the replacement for the feedback-folder intake. Instead of writing
 * a markdown file into `session-manager-operations/feedback/` for a separate
 * skill to later parse, triage, dedupe and re-queue, an agent files a
 * `proposed` Epic: it appears in the Epics workspace with an Approve & start
 * gate, and nothing runs or is spent until a human presses it.
 *
 * One mechanism replaces the whole intake pipeline — the proposal IS the
 * work item, already in the place work is done, already carrying its own
 * session and PRD directory.
 *
 * Usage:
 *   node scripts/propose-epic.cjs <cwd> "<one-line title>" [feature|bug|discussion]
 *     # full body (the first prompt sent on approval) is read from stdin;
 *     # when stdin is empty the title is used as the body.
 *
 * Prints the Epic id on stdout. Reuse-by-title: re-proposing the same title
 * into the same project joins the existing proposal instead of duplicating it.
 */
'use strict';

const { ensureEpic } = require('../src/main/lib/epicMint.cjs');

const [cwd, title, tag] = process.argv.slice(2);
if (!cwd || !title) {
  process.stderr.write('usage: propose-epic.cjs <cwd> "<title>" [feature|bug|discussion]  (body on stdin)\n');
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

(async () => {
  const body = (await readStdin()).trim();
  const { epicId, created } = await ensureEpic(cwd, {
    goalText: title,
    tag: tag || 'feature',
    status: 'proposed',
    reuseByGoal: true,
    openingPrompt: body || title,
  });
  process.stderr.write(`${created ? 'proposed' : 'joined existing proposal'} epic ${epicId}\n`);
  process.stdout.write(`${epicId}\n`);
})();
