'use strict';
// @ts-check

/**
 * jobSandboxPolicy.cjs — turns a headless PRD job's resolved environment
 * profile (environmentProfiles.cjs) and paths into the claude CLI flags that
 * confine it, or refuses it. Enforcement (schedulerConfig.environmentEnforcement,
 * default 'enforce'): an environment that requires the OS sandbox when its
 * dependencies are missing is REFUSED (level 'refused', refusal
 * environment_unavailable) — never downgraded to tool rules. The opt-out
 * 'report' mode keeps the old downgrade and records a would-block entry.
 *
 * Two levels:
 *  - 'tool-rules' (every persona): keeps --dangerously-skip-permissions but
 *    passes --settings with permissions.deny Read/Edit rules over the secret
 *    files below. Probed on CLI 2.1.325: these rules ARE enforced under the
 *    bypass flag for the Read/Write tools and plain Bash cat/redirect, but
 *    `python3 -c open(...)` or `sh -c 'cat $1'` still read the file — tool
 *    rules are not containment.
 *  - 'os-sandbox' (an environment with osSandboxRequired — validator and
 *    dev-lead by default — when bwrap+socat / sandbox-exec are present): drops the bypass flag, runs under a --permission-mode, and turns
 *    on the CLI's OS sandbox (Bash only — in-process tools stay governed by the
 *    permission rules): writes only in the worktree plus declared roots, secret
 *    files unreadable, Bash network limited to the environment's allowlist.
 *
 * Rule paths: a leading `//` is absolute; a single `/` is relative to the
 * settings file — so every rule here is `//` + the absolute path sans its `/`.
 *
 * Pure: no fs, child_process, os or clock. The caller probes dependencies via
 * sandboxDependencies({ platform, which }) and passes the result in.
 */

const path = require('node:path');
const { VAULT_FILE_ROOTS, credentialFilePaths } = require('./vaultRefs.cjs');

/** Home-relative paths whose contents no job tool may read or write. */
const SANDBOX_SECRET_PATHS = Object.freeze([
  '.npmrc',
  '.netrc',
  '.ssh',
  '.gnupg',
  '.claude/.credentials.json',
  '.config/gh',
  '.google_workspace_mcp',
  '.config/google-workspace-mcp',
  '.aws',
  '.docker/config.json',
  // Every file: vault root (vaultRefs.cjs) — vault values reach only out-of-job servers.
  ...VAULT_FILE_ROOTS,
]);

/**
 * Personas that get an environment profile without declaring one in their
 * frontmatter — the two personas the retired persona-keyed SANDBOX_PROFILES
 * covered, mapped onto the built-in environments that reproduce them
 * (environmentProfiles.cjs). Any other persona gets an environment only by
 * declaring `environment:`; without one it stays on tool rules.
 */
const LEGACY_PERSONA_ENVIRONMENTS = Object.freeze({
  validator: 'validator-readonly',
  'dev-lead': 'headless-default',
});

/** Environment enforcement modes (schedulerConfig.environmentEnforcement). */
const ENFORCEMENT_MODES = Object.freeze(['report', 'enforce']);

/**
 * OS packages that provide each sandbox dependency, per platform — what the
 * readiness banner tells the human to install.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
const SANDBOX_DEP_PACKAGES = Object.freeze({
  linux: Object.freeze({ bwrap: 'bubblewrap', socat: 'socat' }),
  darwin: Object.freeze({ 'sandbox-exec': 'sandbox-exec (ships with macOS)' }),
});

/**
 * The install hint for missing sandbox dependencies: the package names, and
 * on linux an apt line. Pure.
 * @param {{ platform: string, missing: string[] }} args
 * @returns {{ packages: string[], command: string|null }}
 */
function sandboxInstallHint({ platform, missing }) {
  const map = Object.prototype.hasOwnProperty.call(SANDBOX_DEP_PACKAGES, platform) ? SANDBOX_DEP_PACKAGES[platform] : null;
  const bins = (missing || []).filter((m) => map && Object.prototype.hasOwnProperty.call(map, m));
  const packages = [...new Set(bins.map((b) => /** @type {Record<string, string>} */ (map)[b]))];
  const command = platform === 'linux' && packages.length ? `sudo apt install ${packages.join(' ')}` : null;
  return { packages, command };
}

/**
 * @param {unknown} mode
 * @returns {'report'|'enforce'}
 */
function normalizeMode(mode) {
  return mode === 'report' ? 'report' : 'enforce';
}

/**
 * The environment name a job runs under: the persona's declared
 * `environment:` wins; else the legacy persona default; else null.
 * @param {{ agentType?: string|null, declared?: string|null }} args
 * @returns {string|null}
 */
function jobEnvironmentName({ agentType, declared } = {}) {
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  if (typeof agentType === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_PERSONA_ENVIRONMENTS, agentType)) {
    return LEGACY_PERSONA_ENVIRONMENTS[agentType];
  }
  return null;
}

const ROOT_TOKEN_RE = /^\{(worktree|projectRoot|home|tmp)\}(\/.*)?$/;

/**
 * @typedef {{ mode: 'none' } | { mode: 'allowlist', hosts: string[] } | { mode: 'open' }} EnvironmentNetwork
 * @typedef {{
 *   osSandboxRequired: boolean,
 *   permissionMode: string,
 *   writeRoots: string[],
 *   network: EnvironmentNetwork,
 *   secretDenyPaths: string[],
 *   webFetch: boolean,
 *   webSearch: boolean,
 * }} EnvironmentProfile
 * @typedef {{ id: string, profile: EnvironmentProfile }} ResolvedEnvironment
 */

/**
 * @param {string[]} roots
 * @param {{ worktreeDir: string, projectRoot: string, homeDir: string, tmpDir: string }} dirs
 * @returns {string[]}
 */
function expandRoots(roots, { worktreeDir, projectRoot, homeDir, tmpDir }) {
  /** @type {Record<string, string>} */
  const base = { worktree: worktreeDir, projectRoot, home: homeDir, tmp: tmpDir };
  return roots.map((r) => {
    const m = r.match(ROOT_TOKEN_RE);
    return m ? path.join(base[m[1]], m[2] || '') : r;
  });
}

/** @param {EnvironmentNetwork} n @returns {string[]|null} */
function networkHosts(n) {
  if (!n || n.mode === 'open') return null;
  return n.mode === 'allowlist' ? [...n.hosts] : [];
}

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
 * @typedef {{ what: 'os_sandbox_unavailable', detail: string }} WouldBlock
 * @typedef {{ code: 'environment_unavailable', detail: string, missing: string[] }} EnvironmentRefusal
 * @typedef {{
 *   level: 'os-sandbox'|'tool-rules'|'refused',
 *   argv: string[],
 *   settings: Record<string, unknown>,
 *   summary: { level: 'os-sandbox'|'tool-rules'|'refused', profile: string|null, environment: string|null, network: string[]|null, reason: string|null },
 *   wouldBlock: WouldBlock[],
 *   refusal: EnvironmentRefusal|null,
 * }} JobSandboxResult
 */

/**
 * Sandbox flags for one job, derived from its resolved environment profile.
 * `environment` null → tool rules (no profile applies to this job). A profile
 * with osSandboxRequired false → tool rules. A profile that requires the OS
 * sandbox when deps are missing → in 'enforce' mode (the default) level
 * 'refused' with `refusal` { code: 'environment_unavailable', detail: the
 * missing deps } and no argv — the caller parks the job, never spawns it; in
 * 'report' mode tool rules plus a `wouldBlock` entry.
 *
 * @param {{
 *   agentType?: string|null,
 *   environment?: ResolvedEnvironment|null,
 *   worktreeDir: string,
 *   projectRoot: string,
 *   homeDir: string,
 *   tmpDir: string,
 *   deps?: { available: boolean, missing?: string[] }|null,
 *   mode?: 'report'|'enforce'|string|null,
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
  const mode = normalizeMode(args.mode);
  const env = args.environment && args.environment.profile ? args.environment : null;
  const envId = env ? String(env.id) : null;
  const profile = env ? env.profile : null;

  const baseRel = profile && Array.isArray(profile.secretDenyPaths) ? profile.secretDenyPaths : SANDBOX_SECRET_PATHS;
  // Each file: credential path is denied whatever the profile lists (the
  // built-ins already deny every VAULT_FILE_ROOTS entry via SANDBOX_SECRET_PATHS).
  const secretRel = [...new Set([...baseRel, ...credentialFilePaths(profile)])];
  const secretAbs = secretRel.map((p) => path.join(homeDir, p));
  const deny = secretAbs.flatMap(denyRulesFor);

  /** @type {WouldBlock[]} */
  const wouldBlock = [];
  /** @type {string|null} */
  let reason = null;
  if (!profile) {
    reason = `no environment profile for persona ${agentType ?? '(none)'}`;
  } else if (!profile.osSandboxRequired) {
    reason = `environment ${envId} does not require the OS sandbox`;
  } else if (!deps || deps.available !== true) {
    const missing = deps && Array.isArray(deps.missing) && deps.missing.length ? deps.missing : ['unknown'];
    reason = `OS sandbox unavailable, missing: ${missing.join(', ')}`;
    if (mode === 'enforce') {
      return {
        level: 'refused',
        argv: [],
        settings: {},
        summary: { level: 'refused', profile: agentType, environment: envId, network: null, reason },
        wouldBlock: [],
        refusal: { code: 'environment_unavailable', detail: missing.join(', '), missing: [...missing] },
      };
    }
    wouldBlock.push({ what: 'os_sandbox_unavailable', detail: reason });
  }

  if (!profile || reason) {
    const settings = { permissions: { deny } };
    return {
      level: 'tool-rules',
      argv: ['--dangerously-skip-permissions', '--settings', JSON.stringify(settings)],
      settings,
      summary: { level: 'tool-rules', profile: agentType, environment: envId, network: null, reason },
      wouldBlock,
      refusal: null,
    };
  }

  const hosts = networkHosts(profile.network);
  const denyTools = [...(profile.webFetch ? [] : ['WebFetch']), ...(profile.webSearch ? [] : ['WebSearch'])];
  const settings = {
    permissions: {
      allow: ['Read(//**)', 'Glob', 'Grep', 'Bash', 'Skill', 'Agent', 'ToolSearch', 'TodoWrite'],
      deny: [...deny, ...denyTools],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        // .git: a job worktree commits into the main checkout's .git (objects,
        // refs, worktrees/<name>); the CLI sandbox keeps .git/hooks and
        // .git/config read-only itself. The roots come from the profile.
        allowWrite: expandRoots(profile.writeRoots, { worktreeDir, projectRoot, homeDir, tmpDir }),
        denyRead: secretAbs,
      },
      credentials: { files: secretAbs.map((p) => ({ path: p, mode: 'deny' })) },
      // 'open' network: no allow-list at all.
      ...(hosts ? { network: { allowedDomains: hosts, strictAllowlist: true } } : {}),
    },
  };
  return {
    level: 'os-sandbox',
    argv: ['--permission-mode', profile.permissionMode, '--settings', JSON.stringify(settings)],
    settings,
    summary: { level: 'os-sandbox', profile: agentType, environment: envId, network: hosts ? [...hosts] : null, reason: null },
    wouldBlock,
    refusal: null,
  };
}

/**
 * The env vars the job's PreToolUse hook (guard-tool-risk) reads to deny
 * ('enforce', the default) or only report ('report') the WebFetch/WebSearch
 * calls the job's environment disallows. Empty when no environment applies.
 * @param {{ environment?: ResolvedEnvironment|null, mode: string, agentType?: string|null }} args
 * @returns {Record<string, string>}
 */
function environmentHookEnv({ environment, mode, agentType }) {
  if (!environment || !environment.profile) return {};
  const p = environment.profile;
  return {
    SM_JOB_ENVIRONMENT: JSON.stringify({ id: environment.id, webFetch: !!p.webFetch, webSearch: !!p.webSearch, network: p.network }),
    SM_JOB_ENVIRONMENT_MODE: normalizeMode(mode),
    SM_JOB_PERSONA: agentType || '',
  };
}

/** @param {unknown} url @returns {string|null} */
function hostOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try { return new URL(url).hostname.toLowerCase() || null; } catch { return null; }
}

/** @param {string} host @param {string} pattern */
function hostMatches(host, pattern) {
  const p = String(pattern).toLowerCase();
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) || host === p.slice(2);
  return host === p;
}

/**
 * What a job's environment would block about one WebFetch/WebSearch call,
 * or null. Pure.
 *  - 'webfetch_not_allowed' / 'websearch_not_allowed': the profile disallows the tool.
 *  - 'host_off_allowlist': WebFetch allowed, but the URL's host is outside an
 *    allow-list network (or the network is 'none').
 * @param {{ webFetch?: boolean, webSearch?: boolean, network?: EnvironmentNetwork }|null} env
 * @param {string} toolName
 * @param {any} input
 * @returns {{ what: string, detail: string }|null}
 */
function webToolWouldBlock(env, toolName, input) {
  if (!env || typeof env !== 'object') return null;
  if (toolName === 'WebSearch') {
    if (env.webSearch) return null;
    const q = input && typeof input.query === 'string' ? input.query.slice(0, 200) : '';
    return { what: 'websearch_not_allowed', detail: q };
  }
  if (toolName !== 'WebFetch') return null;
  const url = input && typeof input.url === 'string' ? input.url.slice(0, 500) : '';
  if (!env.webFetch) return { what: 'webfetch_not_allowed', detail: url };
  const n = env.network;
  if (!n || n.mode === 'open') return null;
  const host = hostOf(url);
  const hosts = n.mode === 'allowlist' ? n.hosts : [];
  if (host && hosts.some((h) => hostMatches(host, h))) return null;
  return { what: 'host_off_allowlist', detail: host || url };
}

/**
 * One 'environment_would_block' audit record's fields.
 * @param {{ slug?: string|null, persona?: string|null, environment?: string|null, what: string, detail?: string|null, mode?: string|null }} f
 */
function wouldBlockRecord({ slug, persona, environment, what, detail, mode }) {
  return {
    slug: slug || null,
    persona: persona || null,
    environment: environment || null,
    what,
    detail: detail ?? null,
    mode: normalizeMode(mode),
  };
}

/**
 * Env vars a job's child process needs for its sandbox level. An os-sandbox
 * job gets TMPDIR/TMP/TEMP pointed at its private temp dir (the only tmp
 * write root its settings declare) and, with an allowlist network,
 * NODE_USE_ENV_PROXY=1; tool-rules jobs get no env change.
 *
 * @param {{ level?: string }|null|undefined} policy
 * @param {string} tmpDir
 * @returns {Record<string, string>}
 */
function sandboxChildEnv(policy, tmpDir) {
  if (!policy || policy.level !== 'os-sandbox') return {};
  const env = { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir };
  // Node's https ignores HTTPS_PROXY unless asked; inside the sandbox the proxy
  // is the only route to an allow-listed host.
  const hosts = policy.summary && policy.summary.network;
  if (Array.isArray(hosts) && hosts.length > 0) env.NODE_USE_ENV_PROXY = '1';
  return env;
}

module.exports = {
  SANDBOX_SECRET_PATHS,
  LEGACY_PERSONA_ENVIRONMENTS,
  ENFORCEMENT_MODES,
  SANDBOX_DEP_PACKAGES,
  sandboxInstallHint,
  jobEnvironmentName,
  sandboxDependencies,
  buildJobSandboxSettings,
  sandboxChildEnv,
  environmentHookEnv,
  webToolWouldBlock,
  wouldBlockRecord,
};
