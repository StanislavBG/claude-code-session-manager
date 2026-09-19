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

afterEach(() => {
  require('../helpers/claudeStub.cjs').reapClaudeStubs();
});
