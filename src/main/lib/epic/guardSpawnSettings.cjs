/**
 * guardSpawnSettings.cjs — builds the Claude Code settings object carrying
 * Session Manager's four PreToolUse guard hooks for ONE claude spawn, and
 * writes it to a stable file for `claude --settings <file>`.
 *
 * Why: Epic chats and scheduler jobs run in git worktrees that carry only
 * tracked files, so guards written into an untracked project
 * .claude/settings.json never load there; `--settings` does.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { GUARD_DEFS, checkGuard } = require('./delegationReadiness.cjs');
const { shimPath: guardShimPath, ensureGuardShimsOrError } = require('../guardShims.cjs');
const { nodeShellCommand } = require('../appRuntime.cjs');
const { writeTextAtomic } = require('../util/atomicFs.cjs');

/**
 * @param {{ spawnCwd: string, homeDir?: string }} opts
 * @returns {{ hooks: { PreToolUse: Array<{ matcher: string, hooks: Array<{ type: string, command: string }> }> } } | null}
 */
function buildGuardSpawnSettings({ spawnCwd, homeDir = os.homedir() }) {
  const byMatcher = new Map();
  for (const def of Object.values(GUARD_DEFS)) {
    if (checkGuard(def, { cwd: spawnCwd, homeDir }).ok) continue;
    if (!byMatcher.has(def.matcher)) byMatcher.set(def.matcher, []);
    byMatcher.get(def.matcher).push({
      type: 'command',
      command: nodeShellCommand(guardShimPath(def.scriptBasename, homeDir)),
    });
  }
  if (byMatcher.size === 0) return null;
  return {
    hooks: {
      PreToolUse: [...byMatcher].map(([matcher, hooks]) => ({ matcher, hooks })),
    },
  };
}

/**
 * Write the settings to <homeDir>/.claude/session-manager/spawn-settings/
 * guards-<sha1[0..12]>.json (content-addressed) and return its absolute path.
 * Returns null (logged, never thrown) when nothing needs injecting or the
 * shims cannot be ensured.
 *
 * @param {{ spawnCwd: string, homeDir?: string, deps?: { ensureShims?: (homeDir: string) => Promise<any> } }} opts
 * @returns {Promise<string | null>}
 */
async function writeGuardSpawnSettingsFile({ spawnCwd, homeDir = os.homedir(), deps = {} }) {
  const ensureShims = deps.ensureShims || ensureGuardShimsOrError;
  try {
    const settings = buildGuardSpawnSettings({ spawnCwd, homeDir });
    if (!settings) return null;
    const shimError = await ensureShims(homeDir);
    if (shimError) {
      console.warn(`[guardSpawnSettings] guard shims unavailable: ${shimError.error ?? shimError}`);
      return null;
    }
    const content = `${JSON.stringify(settings, null, 2)}\n`;
    const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
    const dir = path.join(homeDir, '.claude', 'session-manager', 'spawn-settings');
    const file = path.join(dir, `guards-${hash}.json`);
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(dir, { recursive: true });
    await writeTextAtomic(file, content);
    return file;
  } catch (err) {
    console.warn(`[guardSpawnSettings] could not write spawn settings: ${err?.message ?? err}`);
    return null;
  }
}

module.exports = { buildGuardSpawnSettings, writeGuardSpawnSettingsFile };
