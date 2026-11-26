/**
 * worktreeDeps.cjs — link the main checkout's gitignored top-level
 * dependency dirs (node_modules, .venv, venv) into a fresh worktree.
 *
 * node_modules is never linked whole: the worktree gets a REAL node_modules
 * folder holding one symlink per entry of the main checkout's node_modules
 * (packages, scope folders such as @types linked whole, and .bin; other dot
 * entries — .vite, .cache, .package-lock.json — are not linked, so caches and
 * npm's hidden lockfile stay worktree-local). Why: npm ci reads node_modules'
 * entries and removes each one; through a whole-folder link that deletes the
 * main checkout's packages (2026-11-24: a widget gate's
 * `npm --prefix web/feedback-widget ci` emptied the main checkout's
 * web/feedback-widget/node_modules). With per-entry links an install removes
 * only links. .venv/venv keep the whole-folder link.
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
 * Nested npm packages (e.g. web/remote-app) get the same treatment for their
 * node_modules: for each TRACKED package.json whose dir is at most
 * NESTED_MAX_DEPTH segments deep (never under node_modules), at most
 * NESTED_MAX_PACKAGES of the eligible ones (main has `<dir>/node_modules`, it is
 * gitignored there, the worktree has none — filtered before the cap), the dir is
 * built from per-entry links to the main checkout's (as above) and `/<dir>/node_modules` goes to info/exclude
 * after the link succeeds. Ineligible packages are not reported as skipped. pnpm projects skip this — their
 * offline install already builds every workspace node_modules per worktree.
 *
 * syncNodeModulesLinks refreshes those per-entry links on a reused Epic worktree (the
 * links are a snapshot; the old whole-folder link saw packages added to main later).
 *
 * Never throws; failures land in `skipped` (nested entries as `<rel> (<reason>)`);
 * a failed node_modules build is removed again (links only, never their targets).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { execGit } = require('./gitExec.cjs');
const { runWorktreeSetup } = require('./worktreeSetup.cjs');

const DEFAULT_DEP_DIRS = ['node_modules', '.venv', 'venv'];
const NESTED_MAX_DEPTH = 3;
const NESTED_MAX_PACKAGES = 20;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** True for a node_modules entry that gets a link: anything not dot-prefixed, plus `.bin`. */
function isLinkedModulesEntry(name) {
  return !name.startsWith('.') || name === '.bin';
}

/**
 * Link every linked entry of `src` (a main-checkout node_modules) that `dest` (a real
 * worktree node_modules folder) lacks. Existing dest entries — links or real — are never
 * touched. `strict` rethrows a symlink failure (initial build); otherwise failures are
 * skipped per entry. Returns the count of links made.
 */
function linkMissingModulesEntries(src, dest, strict) {
  let added = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!isLinkedModulesEntry(e.name)) continue;
    const link = path.join(dest, e.name);
    if (exists(link)) continue;
    const target = path.join(src, e.name);
    try {
      fs.symlinkSync(target, link, isDir(target) ? 'dir' : 'file');
      added++;
    } catch (err) {
      if (strict) throw err;
    }
  }
  return added;
}

/**
 * Create `dest` as a real directory holding one symlink per linked entry of `src` (a
 * node_modules folder). Throws on failure after removing whatever it created at `dest`;
 * removal unlinks links only — it never follows them into `src`.
 */
function linkModulesEntries(src, dest) {
  fs.mkdirSync(dest);
  try {
    linkMissingModulesEntries(src, dest, true);
  } catch (err) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
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
 * Dirs (posix, relative) of tracked nested package.json files in worktreeCwd, at most
 * NESTED_MAX_DEPTH segments deep and never under a node_modules segment. Sorted. Never throws.
 */
async function nestedPackageDirs(worktreeCwd) {
  try {
    const specs = [];
    for (let d = 1; d <= NESTED_MAX_DEPTH; d++) specs.push(`:(glob)${'*/'.repeat(d)}package.json`);
    const out = await execGit(worktreeCwd, ['ls-files', '-z', '--', ...specs], { timeout: 10_000 });
    const dirs = new Set();
    for (const f of out.split('\0')) {
      if (!f) continue;
      const segs = f.split('/').slice(0, -1);
      if (!segs.length || segs.length > NESTED_MAX_DEPTH || segs.includes('node_modules')) continue;
      dirs.add(segs.join('/'));
    }
    return [...dirs].sort();
  } catch { return []; }
}

/**
 * Build `<dir>/node_modules` (per-entry links) for nested npm packages; pushes into linked/skipped. Never throws.
 * Filter first (main has it, it is gitignored, the worktree has none), then cap at
 * NESTED_MAX_PACKAGES, so ineligible packages never take a slot and never appear in
 * `skipped`. `skipped` gets only eligible packages left unlinked, as `<rel> (<reason>)`.
 * The info/exclude line is written only after the links succeed; if that write fails
 * the folder of links is removed again so status stays clean.
 */
async function linkNestedNodeModules(mainCwd, worktreeCwd, linked, skipped) {
  try {
    if (isPnpmProject(mainCwd)) return;
    const eligible = [];
    for (const dir of await nestedPackageDirs(worktreeCwd)) {
      const rel = `${dir}/node_modules`;
      try {
        if (!isDir(path.join(mainCwd, rel)) || exists(path.join(worktreeCwd, rel))) continue;
        if (!(await isIgnored(mainCwd, rel))) continue;
        eligible.push(rel);
      } catch { /* ineligible */ }
    }
    for (const rel of eligible.slice(NESTED_MAX_PACKAGES)) {
      skipped.push(`${rel} (over the ${NESTED_MAX_PACKAGES}-package cap)`);
    }
    for (const rel of eligible.slice(0, NESTED_MAX_PACKAGES)) {
      const src = path.join(mainCwd, rel);
      const dest = path.join(worktreeCwd, rel);
      try {
        linkModulesEntries(src, dest);
      } catch (err) {
        skipped.push(`${rel} (symlink failed: ${(err && err.code) || (err && err.message) || err})`);
        continue;
      }
      try {
        await addExcludes(mainCwd, [rel]);
        linked.push(rel);
      } catch (err) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
        skipped.push(`${rel} (exclude write failed: ${(err && err.code) || (err && err.message) || err})`);
      }
    }
  } catch { /* best-effort */ }
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
      if (name === 'node_modules') linkModulesEntries(src, dest);
      else fs.symlinkSync(src, dest, 'dir');
      linked.push(name);
    } catch {
      skipped.push(name);
    }
  }
  if (names.includes('node_modules')) await linkNestedNodeModules(mainCwd, worktreeCwd, linked, skipped);
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

/**
 * Refresh one worktree node_modules (`rel`) against the main checkout's: link entries main
 * gained since the snapshot, unlink dangling worktree links whose target lay inside main's
 * `rel` (others are kept, counted in `counts.kept`). Skips unless the
 * worktree folder is a real directory (a whole-folder symlink is left alone). Reads main
 * only. Never throws.
 */
function syncModulesDir(mainCwd, worktreeCwd, rel, counts) {
  try {
    const dest = path.join(worktreeCwd, rel);
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    const src = path.join(mainCwd, rel);
    if (isDir(src)) counts.added += linkMissingModulesEntries(src, dest, false);
    const ownPrefix = path.resolve(src) + path.sep; // trailing sep: main/node_modules-x is not inside
    for (const name of fs.readdirSync(dest)) {
      const link = path.join(dest, name);
      try {
        if (!fs.lstatSync(link).isSymbolicLink() || fs.existsSync(link)) continue;
        const target = path.resolve(dest, fs.readlinkSync(link));
        if (!target.startsWith(ownPrefix)) { counts.kept++; continue; } // not linker-made: leave it
        fs.unlinkSync(link); // removes the dangling link itself, never a target
        counts.removed++;
      } catch { /* best-effort per entry */ }
    }
  } catch { /* absent or unreadable */ }
}

/**
 * Bring a reused (long-lived Epic) worktree's per-entry node_modules links up to date with
 * the main checkout — root plus each nested npm package (same set linkNestedNodeModules
 * considers). pnpm projects are skipped (their worktree node_modules is a real install).
 * No-op under SM_WORKTREE_DEP_LINK_DISABLE=1. Never throws.
 * @param {{ mainCwd: string, worktreeCwd: string }} opts
 * Only dangling links into the main checkout's matching node_modules (the linker's own) are
 * removed; any other dangling link (e.g. a workspace package mid-build) is kept and counted.
 * @returns {Promise<{ added: number, removed: number, kept: number }>}
 */
async function syncNodeModulesLinks({ mainCwd, worktreeCwd }) {
  const counts = { added: 0, removed: 0, kept: 0 };
  try {
    if (process.env.SM_WORKTREE_DEP_LINK_DISABLE === '1') return counts;
    if (!mainCwd || !worktreeCwd || isPnpmProject(mainCwd)) return counts;
    const rels = ['node_modules'];
    for (const dir of await nestedPackageDirs(worktreeCwd)) rels.push(`${dir}/node_modules`);
    for (const rel of rels) syncModulesDir(mainCwd, worktreeCwd, rel, counts);
  } catch { /* best-effort */ }
  return counts;
}

module.exports = { linkDependencyDirs, syncNodeModulesLinks, isPnpmProject, isUvProject, DEFAULT_DEP_DIRS, NESTED_MAX_PACKAGES };
