'use strict';
// @ts-check

/**
 * jobSandboxPolicy.cjs — turns a headless PRD job's persona and paths into the
 * claude CLI flags that confine it.
 *
 * Two levels:
 *  - 'tool-rules' (every persona): keeps --dangerously-skip-permissions but
 *    passes --settings with permissions.deny Read/Edit rules over the secret
 *    files below. Probed on CLI 2.1.325: these rules ARE enforced under the
 *    bypass flag for the Read/Write tools and plain Bash cat/redirect, but
 *    `python3 -c open(...)` or `sh -c 'cat $1'` still read the file — tool
 *    rules are not containment.
 *  - 'os-sandbox' (validator, dev-lead, when bwrap+socat / sandbox-exec are
 *    present): drops the bypass flag, runs under a --permission-mode, and turns
 *    on the CLI's OS sandbox (Bash only — in-process tools stay governed by the
 *    permission rules): writes only in the worktree plus declared roots, secret
 *    files unreadable, Bash network limited to the profile's allowlist.
 *
 * Rule paths: a leading `//` is absolute; a single `/` is relative to the
 * settings file — so every rule here is `//` + the absolute path sans its `/`.
 *
 * Pure: no fs, child_process, os or clock. The caller probes dependencies via
 * sandboxDependencies({ platform, which }) and passes the result in.
 */

const path = require('node:path');

/** Home-relative paths whose contents no job tool may read or write. */
const SANDBOX_SECRET_PATHS = Object.freeze([
  '.npmrc',
  '.netrc',
  '.ssh',
  '.gnupg',
  'Self/secrets',
  '.claude/.credentials.json',
  '.config/gh',
  '.google_workspace_mcp',
  '.config/google-workspace-mcp',
  '.aws',
  '.docker/config.json',
]);

/**
 * @typedef {{ readonly permissionMode: string, readonly network: readonly string[] }} SandboxProfile
 */

/** @type {Readonly<Record<string, SandboxProfile>>} */
const SANDBOX_PROFILES = Object.freeze({
  validator: Object.freeze({ permissionMode: 'default', network: Object.freeze([]) }),
  'dev-lead': Object.freeze({ permissionMode: 'acceptEdits', network: Object.freeze(['registry.npmjs.org']) }),
});

/** @type {Readonly<Record<string, readonly string[]>>} */
const PLATFORM_DEPS = Object.freeze({
  linux: Object.freeze(['bwrap', 'socat']),
  darwin: Object.freeze(['sandbox-exec']),
});

/**
 * @param {{ platform: string, which: (name: string) => string|null }} args
 * @returns {{ available: boolean, missing: string[] }}
 */
function sandboxDependencies({ platform, which }) {
  const needed = Object.prototype.hasOwnProperty.call(PLATFORM_DEPS, platform) ? PLATFORM_DEPS[platform] : null;
  if (!needed) return { available: false, missing: [`unsupported platform: ${platform}`] };
  const missing = needed.filter((name) => !which(name));
  return { available: missing.length === 0, missing };
}

/** @param {string} abs */
function denyRulesFor(abs) {
  const p = `/${abs.replace(/^\/+/, '')}`;
  return [`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p})`, `Edit(/${p}/**)`];
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} field
 * @returns {string}
 */
function requireAbs(args, field) {
  const v = args[field];
  if (typeof v !== 'string' || v.length === 0 || !path.isAbsolute(v)) {
    throw new TypeError(`buildJobSandboxSettings: ${field} must be an absolute path (got ${JSON.stringify(v)})`);
  }
  return v;
}

/**
 * @typedef {{
 *   level: 'os-sandbox'|'tool-rules',
 *   argv: string[],
 *   settings: Record<string, unknown>,
 *   summary: { level: 'os-sandbox'|'tool-rules', profile: string|null, network: string[]|null, reason: string|null },
 * }} JobSandboxResult
 */

/**
 * @param {{
 *   agentType?: string|null,
 *   worktreeDir: string,
 *   projectRoot: string,
 *   homeDir: string,
 *   tmpDir: string,
 *   deps?: { available: boolean, missing?: string[] }|null,
 * }} args
 * @returns {JobSandboxResult}
 */
function buildJobSandboxSettings(args) {
  const raw = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (args || {}));
  const worktreeDir = requireAbs(raw, 'worktreeDir');
  const projectRoot = requireAbs(raw, 'projectRoot');
  const homeDir = requireAbs(raw, 'homeDir');
  const tmpDir = requireAbs(raw, 'tmpDir');
  const agentType = typeof args.agentType === 'string' && args.agentType ? args.agentType : null;
  const deps = args.deps;

  const secretAbs = SANDBOX_SECRET_PATHS.map((p) => path.join(homeDir, p));
  const deny = secretAbs.flatMap(denyRulesFor);

  const profile =
    agentType && Object.prototype.hasOwnProperty.call(SANDBOX_PROFILES, agentType) ? SANDBOX_PROFILES[agentType] : null;

  /** @type {string|null} */
  let reason = null;
  if (!profile) {
    reason = `no sandbox profile for persona ${agentType ?? '(none)'}`;
  } else if (!deps || deps.available !== true) {
    const missing = deps && Array.isArray(deps.missing) && deps.missing.length ? deps.missing : ['unknown'];
    reason = `OS sandbox unavailable, missing: ${missing.join(', ')}`;
  }

  if (!profile || reason) {
    const settings = { permissions: { deny } };
    return {
      level: 'tool-rules',
      argv: ['--dangerously-skip-permissions', '--settings', JSON.stringify(settings)],
      settings,
      summary: { level: 'tool-rules', profile: agentType, network: null, reason },
    };
  }

  const settings = {
    permissions: {
      allow: ['Read(//**)', 'Glob', 'Grep', 'Bash', 'Skill', 'Agent', 'ToolSearch', 'TodoWrite'],
      deny: [...deny, 'WebFetch', 'WebSearch'],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        // .git: a job worktree commits into the main checkout's .git (objects,
        // refs, worktrees/<name>); the CLI sandbox keeps .git/hooks and
        // .git/config read-only itself.
        allowWrite: [
          worktreeDir,
          path.join(projectRoot, '.git'),
          tmpDir,
          path.join(homeDir, '.npm'),
          path.join(homeDir, '.cache'),
          path.join(projectRoot, 'node_modules', '.vite'),
          path.join(projectRoot, 'node_modules', '.vitest'),
        ],
        denyRead: secretAbs,
      },
      credentials: { files: secretAbs.map((p) => ({ path: p, mode: 'deny' })) },
      network: { allowedDomains: [...profile.network], strictAllowlist: true },
    },
  };
  return {
    level: 'os-sandbox',
    argv: ['--permission-mode', profile.permissionMode, '--settings', JSON.stringify(settings)],
    settings,
    summary: { level: 'os-sandbox', profile: agentType, network: [...profile.network], reason: null },
  };
}

module.exports = {
  SANDBOX_SECRET_PATHS,
  SANDBOX_PROFILES,
  sandboxDependencies,
  buildJobSandboxSettings,
};
