'use strict';
/**
 * Shared setup helpers for src/main/__tests__/scheduler-*.test.cjs.
 * NOT a test file (no .test.cjs suffix). Helpers that need the per-test fake
 * HOME read process.env.HOME at call time, so they work with each file's own
 * beforeAll/beforeEach that points HOME at a tmpdir.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

/**
 * Make `cwd` discoverable as a project by writing a transcript under
 * $HOME/.claude/projects. With an explicit `slug` the dir is named `slug` and
 * the cwd cache is busted; without it the dir is `fake-project-slug-<basename>`
 * and the cache is left alone (matches the original local variants).
 */
function registerActiveProject(cwd, slug) {
  const projectsDir = path.join(process.env.HOME, '.claude', 'projects');
  const slugDir = path.join(projectsDir, slug || `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  if (slug) require('../../lib/queueStore.cjs').bustCwdCache();
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

/** mkdtemp a fixture cwd and record it in `tmpDirs` for the caller's afterEach. */
function makeFixtureCwd(prefix, tmpDirs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(cwd);
  return cwd;
}

function writeRunLog(runId, slug, lines) {
  const runDir = path.join(process.env.HOME, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${slug}.log`), lines.join('\n') + '\n');
}

/**
 * Drop cached src/main modules so a merged test file's describe blocks each
 * load scheduler.cjs & co. fresh under their own HOME (one file == one
 * module registry before merging).
 */
function clearMainModuleCache() {
  const root = path.resolve(__dirname, '..', '..') + path.sep;
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(root) && !k.includes(`${path.sep}__tests__${path.sep}`)) delete require.cache[k];
  }
}

module.exports = {
  git, initRepo, registerActiveProject,
  writeProjectQueue, makeFixtureCwd, writeRunLog,
  clearMainModuleCache,
};
