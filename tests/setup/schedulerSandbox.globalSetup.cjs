'use strict';

/**
 * vitest globalSetup — one throwaway sandbox per run. Publishes SM_SCHEDULER_HOME,
 * SM_WORKTREE_ROOT, SM_ADMIN_TOKEN_PATH, SM_CLAUDE_VERSION and HOME via provide()
 * (workers read them with inject() in tests/setup/schedulerSandbox.cjs) AND
 * process.env (inherited by forked workers and any child they spawn).
 * Teardown removes the sandbox.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sandbox = null;

module.exports = function setup({ provide }) {
  // realpath: os.tmpdir() may be a symlink; the guard compares resolved paths.
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-vitest-sandbox-')));
  const home = path.join(sandbox, 'home');
  // Same shape as the default (<HOME>/.claude/session-manager) so config.cjs's home-rooted
  // allowed-roots boundary covers it exactly as it does in production.
  const schedulerHome = path.join(home, '.claude', 'session-manager');
  const worktreeRoot = path.join(sandbox, 'worktrees');
  for (const d of [home, schedulerHome, worktreeRoot]) fs.mkdirSync(d, { recursive: true });

  const env = {
    SM_SCHEDULER_HOME: schedulerHome,
    SM_WORKTREE_ROOT: worktreeRoot,
    SM_ADMIN_TOKEN_PATH: path.join(schedulerHome, 'admin-api.test.json'),
    SM_CLAUDE_VERSION: '0.0.0-vitest',
    HOME: home,
    SM_SANDBOX_DIR: sandbox,
  };
  provide('schedulerSandbox', env);
  Object.assign(process.env, env);

  return function teardown() {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = null;
  };
};
