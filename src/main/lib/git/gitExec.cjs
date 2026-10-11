/**
 * gitExec.cjs — shared `git` exec primitive + worktree-porcelain parser.
 *
 * Consolidates three near-duplicate `execGit` helpers that grew up
 * independently (gitWorktree.cjs, branchSweep.cjs, scheduler.cjs's
 * `execGitAt`) into one implementation. Deliberately has ZERO requires of
 * electron, scheduler.cjs, or gitWorktree.cjs — gitWorktree.cjs's own
 * comment (near its `unquotePorcelainPath`) notes scheduler.cjs requires
 * gitWorktree.cjs, so anything gitWorktree.cjs or scheduler.cjs needs to
 * share must live BELOW both in the require graph, never above. This file
 * is that floor.
 *
 * Always `execFile('git', ...)` with an argv array — never a shell string,
 * never `shell: true`.
 */
'use strict';

const { execFile } = require('node:child_process');

/**
 * execGit(cwd, args, opts?) → Promise<string> (stdout)
 *
 * `opts.timeout` (default 20_000ms), `opts.maxBuffer` (node's own execFile
 * default when omitted), `opts.env` (merged over `process.env`, never
 * replacing it — so PATH/HOME etc. survive). Rejects with the raw execFile
 * error, decorated with `err.stderrText` and `err.stdoutText` — some git
 * subcommands (e.g. `diff --no-index`) exit non-zero to mean "found a
 * difference", not "failed", so callers that need the output back can
 * recover it off the rejected error rather than losing it.
 */
function execGit(cwd, args, opts = {}) {
  const { timeout = 20_000, maxBuffer, env } = opts;
  const execOpts = {
    cwd,
    timeout,
    windowsHide: true,
    encoding: 'utf8',
  };
  if (maxBuffer !== undefined) execOpts.maxBuffer = maxBuffer;
  if (env) execOpts.env = { ...process.env, ...env };
  return new Promise((resolve, reject) => {
    execFile('git', args, execOpts, (err, stdout, stderr) => {
      if (err) {
        err.stderrText = stderr;
        err.stdoutText = stdout;
        reject(err);
        return;
      }
      resolve(stdout || '');
    });
  });
}

/** Parse `git worktree list --porcelain` into `[{ worktree, branch }]`. */
function parseWorktreePorcelain(text) {
  const entries = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { worktree: line.slice('worktree '.length).trim(), branch: null };
      entries.push(cur);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

module.exports = { execGit, parseWorktreePorcelain };
