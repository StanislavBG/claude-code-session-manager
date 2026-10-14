/**
 * worktreeDeps.cjs — symlink the main checkout's gitignored top-level
 * dependency dirs (node_modules, .venv, venv) into a fresh worktree.
 *
 * `git worktree add` checks out tracked files only, so a job worktree has no
 * dependencies and executors park needs_review. A gitignore pattern like
 * `node_modules/` (trailing slash) matches directories only and a symlink is
 * not a directory, so each linked name is also written to the repo's shared
 * `info/exclude` as `/<name>` — otherwise the link shows as untracked and the
 * job parks as `uncommitted_changes`.
 *
 * Never throws; failures land in `skipped`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execGit } = require('./gitExec.cjs');

const DEFAULT_DEP_DIRS = ['node_modules', '.venv', 'venv'];

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

async function isIgnored(cwd, name) {
  try {
    await execGit(cwd, ['check-ignore', '-q', name], { timeout: 10_000 });
    return true;
  } catch { return false; }
}

async function addExcludes(mainCwd, names) {
  const out = (await execGit(mainCwd, ['rev-parse', '--git-common-dir'], { timeout: 10_000 })).trim();
  const commonDir = path.resolve(mainCwd, out);
  const file = path.join(commonDir, 'info', 'exclude');
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = names.map((n) => `/${n}`).filter((l) => !have.has(l));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${sep}${missing.join('\n')}\n`);
}

/**
 * @param {{ mainCwd: string, worktreeCwd: string, names?: string[] }} opts
 * @returns {Promise<{ linked: string[], skipped: string[] }>}
 */
async function linkDependencyDirs({ mainCwd, worktreeCwd, names = DEFAULT_DEP_DIRS }) {
  const linked = [];
  const skipped = [];
  for (const name of names) {
    try {
      const src = path.join(mainCwd, name);
      const dest = path.join(worktreeCwd, name);
      if (!isDir(src) || exists(dest) || !(await isIgnored(mainCwd, name))) {
        skipped.push(name);
        continue;
      }
      // Exclude first: a link without its exclude line would dirty status.
      await addExcludes(mainCwd, [name]);
      fs.symlinkSync(src, dest, 'dir');
      linked.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { linked, skipped };
}

module.exports = { linkDependencyDirs, DEFAULT_DEP_DIRS };
