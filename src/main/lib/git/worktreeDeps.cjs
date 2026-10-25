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
 * pnpm projects are the exception for node_modules: `pnpm install` purges and
 * rebuilds the modules dir THROUGH a symlink, wiping the main checkout's
 * node_modules. So a pnpm worktree gets its own node_modules, installed
 * offline from the shared store (`installed`); the main checkout is never
 * touched. `node_modules/` (any depth) is excluded so nested workspace
 * node_modules stay untracked.
 *
 * Relative `file:`/`link:` deps that point OUTSIDE the repo (e.g.
 * `file:../Bilko/packages/host-kit`) cannot resolve from a worktree, which lives
 * under the session-manager state dir rather than next to the sibling repo — the
 * offline install would ENOENT and leave no node_modules. So before installing,
 * `linkOutOfRepoLocalDeps` creates a symlink at the equivalent location relative
 * to the worktree (first path segment past the `..` hops, e.g.
 * `<worktrees>/<hash>/Bilko -> ~/Projects/Bilko`). That link may therefore sit
 * OUTSIDE the worktree; it is only created where nothing exists, never inside
 * the main checkout, and never overwrites anything.
 *
 * uv projects (`uv.lock`) are the exception for .venv/venv: `uv run` and
 * `uv sync` re-sync the project env, and for an editable project install that
 * rewrites site-packages/<pkg>.pth to the CURRENT tree's src. Through a shared
 * symlink that silently repoints the main checkout's imports at the worktree
 * (social-signals-trader, 2026-10-18), and worktree tests import whichever
 * tree synced last. So a uv worktree gets its own env, built by an offline
 * frozen `uv sync` (hardlinks from uv's cache — cheap); the main env is never
 * linked. If that sync fails the name is skipped and the executor's own `uv`
 * call builds a worktree-local env — never the main one.
 *
 * Never throws; failures land in `skipped`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { execGit } = require('./gitExec.cjs');
const { runWorktreeSetup } = require('./worktreeSetup.cjs');

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

/** True when mainCwd is a pnpm project (lockfile or pnpm modules manifest). Never throws. */
function isPnpmProject(mainCwd) {
  try {
    return fs.existsSync(path.join(mainCwd, 'pnpm-lock.yaml'))
      || fs.existsSync(path.join(mainCwd, 'node_modules', '.modules.yaml'));
  } catch { return false; }
}

/** True when mainCwd is a uv project (uv.lock). Never throws. */
function isUvProject(mainCwd) {
  try { return fs.existsSync(path.join(mainCwd, 'uv.lock')); } catch { return false; }
}

/** Offline frozen `uv sync` into worktreeCwd/<name>. Resolves true on exit 0; never throws. */
function installUvEnv(worktreeCwd, name) {
  return new Promise((resolve) => {
    try {
      const env = { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(worktreeCwd, name) };
      delete env.VIRTUAL_ENV;
      execFile(
        'uv',
        ['sync', '--frozen', '--offline'],
        { cwd: worktreeCwd, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
        (err) => resolve(!err),
      );
    } catch { resolve(false); }
  });
}

/** Top-level importer dirs from pnpm-lock.yaml (`.` is the root). Simple line scan; never throws. */
function lockImporters(cwd) {
  const out = ['.'];
  try {
    let inImporters = false;
    for (const line of fs.readFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'utf8').split('\n')) {
      if (/^importers:\s*$/.test(line)) { inImporters = true; continue; }
      if (!inImporters) continue;
      if (/^\S/.test(line)) break;
      const m = /^ {2}(\S[^:]*):\s*$/.exec(line);
      if (m) out.push(m[1].replace(/^(['"])(.*)\1$/, '$2'));
    }
  } catch { /* no lockfile */ }
  return [...new Set(out)];
}

/** Relative file:/link: specifiers of a package.json. Never throws. */
function localSpecs(pkgJson) {
  const specs = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    for (const f of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const v of Object.values(pkg[f] || {})) {
        const m = typeof v === 'string' && /^(?:file|link):(.+)$/.exec(v);
        if (m && !path.isAbsolute(m[1])) specs.push(m[1]);
      }
    }
  } catch { /* unreadable */ }
  return specs;
}

const within = (parent, p) => p === parent || p.startsWith(parent + path.sep);

/**
 * Best-effort: link out-of-repo relative file:/link: dep targets at their
 * worktree-relative location so the offline install can resolve them. Never throws.
 */
function linkOutOfRepoLocalDeps(mainCwd, worktreeCwd) {
  try {
    for (const importer of lockImporters(worktreeCwd)) {
      const mainDir = path.resolve(mainCwd, importer);
      const wtDir = path.resolve(worktreeCwd, importer);
      for (const spec of localSpecs(path.join(mainDir, 'package.json'))) {
        try {
          const target = path.resolve(mainDir, spec);
          if (within(mainCwd, target) || !exists(target)) continue;
          const segs = path.normalize(spec).split(path.sep).filter((x) => x && x !== '.');
          let ups = 0;
          while (segs[ups] === '..') ups++;
          const rest = segs.slice(ups);
          if (!rest.length) continue;
          // Link the first segment past the `..` hops, to the matching target ancestor.
          let wtBase = wtDir;
          for (let i = 0; i < ups; i++) wtBase = path.dirname(wtBase);
          const linkPath = path.join(wtBase, rest[0]);
          let linkTarget = target;
          for (let i = 1; i < rest.length; i++) linkTarget = path.dirname(linkTarget);
          if (within(mainCwd, linkPath) || within(worktreeCwd, linkPath) || exists(linkPath)) continue;
          fs.mkdirSync(path.dirname(linkPath), { recursive: true });
          fs.symlinkSync(linkTarget, linkPath, isDir(linkTarget) ? 'dir' : 'file');
        } catch { /* best-effort per dep */ }
      }
    }
  } catch { /* best-effort */ }
}

/** Offline frozen install in the worktree. Resolves true on exit 0; never throws. */
function installPnpmModules(worktreeCwd) {
  return new Promise((resolve) => {
    try {
      execFile(
        'pnpm',
        ['install', '--offline', '--frozen-lockfile', '--config.confirmModulesPurge=false'],
        { cwd: worktreeCwd, env: { ...process.env, CI: '1' }, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
        (err) => resolve(!err),
      );
    } catch { resolve(false); }
  });
}

async function addExcludeLines(mainCwd, lines) {
  const out = (await execGit(mainCwd, ['rev-parse', '--git-common-dir'], { timeout: 10_000 })).trim();
  const commonDir = path.resolve(mainCwd, out);
  const file = path.join(commonDir, 'info', 'exclude');
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${sep}${missing.join('\n')}\n`);
}

function addExcludes(mainCwd, names) {
  return addExcludeLines(mainCwd, names.map((n) => `/${n}`));
}

/**
 * @param {{ mainCwd: string, worktreeCwd: string, names?: string[] }} opts
 * @returns {Promise<{ linked: string[], skipped: string[], installed: string[], setup: object }>}
 */
async function linkDependencyDirs({ mainCwd, worktreeCwd, names = DEFAULT_DEP_DIRS }) {
  const linked = [];
  const skipped = [];
  const installed = [];
  for (const name of names) {
    try {
      const src = path.join(mainCwd, name);
      const dest = path.join(worktreeCwd, name);
      if (!isDir(src) || exists(dest) || !(await isIgnored(mainCwd, name))) {
        skipped.push(name);
        continue;
      }
      if (name === 'node_modules' && isPnpmProject(mainCwd)) {
        await addExcludeLines(mainCwd, ['node_modules/']);
        linkOutOfRepoLocalDeps(mainCwd, worktreeCwd);
        (await installPnpmModules(worktreeCwd) ? installed : skipped).push(name);
        continue;
      }
      if ((name === '.venv' || name === 'venv') && isUvProject(mainCwd)) {
        await addExcludes(mainCwd, [name]);
        (await installUvEnv(worktreeCwd, name) ? installed : skipped).push(name);
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
  // Project warm-up (.session-manager.json worktreeSetup) runs after linking so it sees node_modules.
  // Both createWorktree and the scheduler's verify scratch worktree come through here. mainCwd lets
  // same-project setups serialize and reports a config missing from the worktree; the outcome is
  // returned unchanged as `setup`. SM_WORKTREE_DEP_LINK_DISABLE=1 skips this at the gitWorktree.cjs call site.
  let setup;
  try {
    setup = await runWorktreeSetup({ worktreeCwd, mainCwd });
  } catch (err) {
    setup = { ran: false, error: String(err && err.message) };
  }
  return { linked, skipped, installed, setup };
}

module.exports = { linkDependencyDirs, isPnpmProject, isUvProject, DEFAULT_DEP_DIRS };
