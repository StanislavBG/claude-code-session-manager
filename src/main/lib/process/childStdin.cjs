'use strict';

/**
 * childStdin.cjs — write a prompt/text to a child's stdin and close it.
 *
 * Why prompts go on stdin, not argv: Linux caps a single argument at
 * MAX_ARG_STRLEN (131072 bytes) and Windows cmd.exe caps a command line at
 * 8191 characters; a larger argv element fails the spawn with E2BIG
 * (incident 2026-10-26, spawn E2BIG). Ending the pipe also satisfies the rule
 * that `claude -p`'s stdin must be closed (claude CLI 2.1.302 read a 204 KB
 * prompt from stdin and exited 0).
 *
 * The EPIPE handling lives here, in one place: a child that exits without
 * reading raises an 'error' on the pipe; it is logged once and swallowed.
 */

/**
 * @param {{ stdin?: any } | null | undefined} child
 * @param {string} text
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {boolean} true when the text was handed to child.stdin
 */
function feedChildStdin(child, text, { log } = {}) {
  if (!child || !child.stdin) return false;
  let logged = false;
  // Listener FIRST: the write can fail asynchronously with EPIPE.
  child.stdin.on('error', (err) => {
    if (logged) return;
    logged = true;
    if (typeof log !== 'function') return;
    try {
      log(`[childStdin] stdin write failed (${(err && (err.code || err.message)) || 'unknown'}): the child exited before reading its input\n`);
    } catch { /* logging must never throw */ }
  });
  child.stdin.end(text, 'utf8');
  return true;
}

module.exports = { feedChildStdin };
