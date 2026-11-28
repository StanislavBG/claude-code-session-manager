'use strict';

/**
 * vitest setupFiles — runs in every worker before any test file (and so before
 * any src module) loads. Applies the per-run sandbox env published by
 * schedulerSandbox.globalSetup.cjs and reaps claude stubs after each test.
 *
 * Home-derived redirects: ~50 tests point HOME at their own temp dir and expect
 * scheduler state under <HOME>/.claude/session-manager. A sandbox-wide
 * SM_SCHEDULER_HOME / SM_ADMIN_TOKEN_PATH would silently override that (a
 * half-redirect), so assigning a HOME OTHER than the sandbox's drops those two
 * home-derived overrides; assigning the sandbox HOME back restores them. The
 * worktree root, claude version and the schedulerPaths guard stay in force.
 */

// ESM import (vite-node transforms .cjs setup files like the tests; require('vitest') is rejected).
import { inject, afterEach } from 'vitest';

// A unit run launched from inside a scheduled job inherits the job's identity env;
// scrub it so tests see a neutral process. Tests that need these set them explicitly.
// NODE_USE_ENV_PROXY is set by the job sandbox and makes every spawned node child print an UNDICI-EHPA warning on stderr.
for (const k of ['SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MCP_TOOLS', 'SM_SCHEDULER_JOB_MAY_QUEUE', 'SM_SCHEDULER_JOB_DEADLINE_MS', 'SM_VOICE_ID', 'SM_PROC_ROLE', 'SM_PROJECT_ROOT', 'NODE_USE_ENV_PROXY']) delete process.env[k];

// Memory cap off by default in tests: no real systemd-run scopes on the host, argv stays unwrapped.
process.env.SM_JOB_MEMORY_MAX_MB = '0';

// Environment enforcement defaults to 'enforce' (PRD 3805), which parks every dev-lead/validator
// executeJob on a host without bwrap/socat. Tests run in 'report' so their outcome never depends on
// the host's packages; tests of enforcement pass mode explicitly or set/delete this var themselves.
process.env.SM_ENVIRONMENT_ENFORCEMENT = 'report';

const env = inject('schedulerSandbox');
if (env) {
  Object.assign(process.env, env);
  const HOME_DERIVED = ['SM_SCHEDULER_HOME', 'SM_ADMIN_TOKEN_PATH'];
  process.env = new Proxy(process.env, {
    set(target, key, value) {
      target[key] = value;
      if (key === 'HOME') {
        for (const k of HOME_DERIVED) {
          if (String(value) === env.HOME) target[k] = env[k];
          else delete target[k];
        }
      }
      return true;
    },
  });
}

// Worktree creation reads <CLAUDE_CONFIG_DIR|~>/.claude.json and takes its .lock dir; keep every
// unit test off the real home config. The globalSetup sandbox provides it (removed
// by its teardown); the fallback only creates a dir when run without the globalSetup. Tests that set CLAUDE_CONFIG_DIR themselves still override it.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.resolve(os.tmpdir());
  const cur = process.env.CLAUDE_CONFIG_DIR;
  const rel = cur ? path.relative(tmp, path.resolve(cur)) : '';
  if (!cur || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, `sm-claude-config-${process.pid}`);
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  }
}

afterEach(() => {
  require('../helpers/claudeStub.cjs').reapClaudeStubs();
});
