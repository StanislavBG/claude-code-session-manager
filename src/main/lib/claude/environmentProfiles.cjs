'use strict';

/**
 * environmentProfiles.cjs — declared environment profiles (Managed Agents'
 * "environment" primitive, kept local).
 *
 * An environment states what a headless run may touch:
 *   - osSandboxRequired: whether the OS sandbox (bwrap+socat / sandbox-exec) is required
 *   - permissionMode:    the CLI --permission-mode under the OS sandbox
 *   - writeRoots:        write roots; each is absolute or starts with a token
 *                        {worktree} / {projectRoot} / {home} / {tmp}
 *   - network:           { mode: 'none' } | { mode: 'allowlist', hosts } | { mode: 'open' }
 *   - secretDenyPaths:   home-relative paths no tool may read or write
 *   - webFetch / webSearch: whether those tools are allowed
 *   - credentials (optional): [{ ref, server, envVar }] local vault refs
 *                        (vaultRefs.cjs) resolved only into that MCP server's
 *                        spawn env, never the job env
 *
 * Resolution for a name (first hit wins, whole-file replace, no merging):
 *   <project>/.claude/environments/<name>.json
 *   ~/.claude/session-manager/environments/<name>.json
 *   the built-ins below (headless-default, validator-readonly, open-web)
 * A file that exists but fails the zod-strict schema (or is not JSON) is
 * REFUSED ('environment_invalid') — never silently skipped to a lower layer.
 * A name found nowhere is refused as 'environment_unknown'.
 *
 * Personas reference one by `environment:` frontmatter; absent = DEFAULT_ENVIRONMENT.
 * The built-ins carry the sandbox settings jobSandboxPolicy.cjs applies by
 * default (validator → validator-readonly, dev-lead → headless-default, via
 * its LEGACY_PERSONA_ENVIRONMENTS); toSandboxProfile maps a profile onto a
 * { permissionMode, network } shape.
 *
 * hash = sha256 of the profile's canonical JSON (agentSnapshot.cjs's canonicalJson),
 * so key order is irrelevant and any edit changes it.
 *
 * Local files only; read-only (no writer here).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { z } = require('zod');
const { SANDBOX_SECRET_PATHS } = require('./jobSandboxPolicy.cjs');
const { canonicalJson } = require('./agentSnapshot.cjs');
const { isVaultRef } = require('./vaultRefs.cjs');

const DEFAULT_ENVIRONMENT = 'headless-default';
const ENV_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const ROOT_TOKEN_RE = /^\{(worktree|projectRoot|home|tmp)\}(\/.*)?$/;

const HostSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9*.-]+$/, 'host must be a domain name (wildcards allowed)');

const NetworkSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('allowlist'), hosts: z.array(HostSchema).min(1) }).strict(),
  z.object({ mode: z.literal('open') }).strict(),
]);

const WriteRootSchema = z
  .string()
  .min(1)
  .refine((v) => ROOT_TOKEN_RE.test(v) || path.isAbsolute(v), 'write root must be absolute or start with {worktree}/{projectRoot}/{home}/{tmp}');

const SecretPathSchema = z
  .string()
  .min(1)
  .refine((v) => !path.isAbsolute(v) && !v.split('/').includes('..'), 'secret deny path must be home-relative');

/**
 * One local vault credential (vaultRefs.cjs): `ref` resolves only into the
 * spawn env of MCP server `server` (which must run outside the job, checked at
 * spawn by assertRefTargetsServer) as `envVar` — never into the job env.
 */
const CredentialSchema = z
  .object({
    ref: z.string().min(1).refine(isVaultRef, 'ref must be keyring:<service>/<account> or file:<path under a vault root>[#KEY]'),
    server: z.string().trim().min(1),
    envVar: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'envVar must look like API_TOKEN'),
  })
  .strict();

const EnvironmentProfileSchema = z
  .object({
    description: z.string().optional(),
    osSandboxRequired: z.boolean(),
    permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']),
    writeRoots: z.array(WriteRootSchema),
    network: NetworkSchema,
    secretDenyPaths: z.array(SecretPathSchema),
    webFetch: z.boolean(),
    webSearch: z.boolean(),
    credentials: z.array(CredentialSchema).optional(),
  })
  .strict();

/** jobSandboxPolicy.cjs's os-sandbox allowWrite list, as tokens. */
const JOB_WRITE_ROOTS = Object.freeze([
  '{worktree}',
  '{projectRoot}/.git',
  '{tmp}',
  '{home}/.npm',
  '{home}/.cache',
  '{projectRoot}/node_modules/.vite',
  '{projectRoot}/node_modules/.vitest',
]);

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

const BUILTIN_ENVIRONMENTS = deepFreeze({
  'headless-default': {
    description: 'OS sandbox + network allow-list (dev-lead today).',
    osSandboxRequired: true,
    permissionMode: 'acceptEdits',
    writeRoots: [...JOB_WRITE_ROOTS],
    network: { mode: 'allowlist', hosts: ['registry.npmjs.org', 'api.github.com'] },
    secretDenyPaths: [...SANDBOX_SECRET_PATHS],
    webFetch: false,
    webSearch: false,
  },
  'validator-readonly': {
    description: 'OS sandbox, no network, default permission mode (validator today).',
    osSandboxRequired: true,
    permissionMode: 'default',
    writeRoots: [...JOB_WRITE_ROOTS],
    network: { mode: 'none' },
    secretDenyPaths: [...SANDBOX_SECRET_PATHS],
    webFetch: false,
    webSearch: false,
  },
  'open-web': {
    description: 'Open network with WebFetch/WebSearch; OS sandbox not required.',
    osSandboxRequired: false,
    permissionMode: 'acceptEdits',
    writeRoots: [...JOB_WRITE_ROOTS],
    network: { mode: 'open' },
    secretDenyPaths: [...SANDBOX_SECRET_PATHS],
    webFetch: true,
    webSearch: true,
  },
});

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Content hash of a profile (canonical JSON, key order irrelevant). */
function environmentHash(profile) {
  return sha256(canonicalJson(profile));
}

/** @param {{ cwd?: string, homeDir?: string }} o */
function environmentFiles(name, { cwd, homeDir } = {}) {
  const home = homeDir || os.homedir();
  const files = [];
  if (typeof cwd === 'string' && cwd) files.push({ source: 'project', file: path.join(cwd, '.claude', 'environments', `${name}.json`) });
  files.push({ source: 'global', file: path.join(home, '.claude', 'session-manager', 'environments', `${name}.json`) });
  return files;
}

function zodErrors(error) {
  return error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') return `unknown key(s): ${issue.keys.join(', ')}`;
    return `${issue.path.length ? issue.path.join('.') : '(profile)'}: ${issue.message}`;
  });
}

/**
 * Resolve environment `name` (default headless-default) for project `cwd`.
 * @param {{ cwd?: string, name?: string|null, homeDir?: string }} opts
 * @returns {{ id: string, hash: string, profile: object, source: 'project'|'global'|'builtin', file: string|null }
 *   | { code: 'environment_unknown', name: string }
 *   | { code: 'environment_invalid', name: string, file: string, errors: string[] }}
 */
function loadEnvironment({ cwd, name, homeDir } = {}) {
  const id = name === undefined || name === null || name === '' ? DEFAULT_ENVIRONMENT : String(name);
  if (!ENV_NAME_RE.test(id)) return { code: 'environment_unknown', name: id };

  for (const { source, file } of environmentFiles(id, { cwd, homeDir })) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { code: 'environment_invalid', name: id, file, errors: [`unreadable: ${e && e.message}`] };
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { code: 'environment_invalid', name: id, file, errors: [`not JSON: ${e && e.message}`] };
    }
    const parsed = EnvironmentProfileSchema.safeParse(raw);
    if (!parsed.success) return { code: 'environment_invalid', name: id, file, errors: zodErrors(parsed.error) };
    return { id, hash: environmentHash(parsed.data), profile: parsed.data, source, file };
  }

  if (Object.prototype.hasOwnProperty.call(BUILTIN_ENVIRONMENTS, id)) {
    const profile = BUILTIN_ENVIRONMENTS[id];
    return { id, hash: environmentHash(profile), profile, source: 'builtin', file: null };
  }
  return { code: 'environment_unknown', name: id };
}

/**
 * A profile as { permissionMode, network }. network: the
 * allow-list hosts ([] for 'none'), or null for 'open' (no allow-list).
 * @returns {{ permissionMode: string, network: string[]|null }}
 */
function toSandboxProfile(profile) {
  const n = profile.network;
  return {
    permissionMode: profile.permissionMode,
    network: n.mode === 'open' ? null : n.mode === 'allowlist' ? [...n.hosts] : [],
  };
}

/**
 * Absolute write roots for a job, tokens substituted.
 * @param {{ writeRoots: string[] }} profile
 * @param {{ worktreeDir: string, projectRoot: string, homeDir: string, tmpDir: string }} dirs
 */
function expandWriteRoots(profile, { worktreeDir, projectRoot, homeDir, tmpDir }) {
  const base = { worktree: worktreeDir, projectRoot, home: homeDir, tmp: tmpDir };
  return profile.writeRoots.map((r) => {
    const m = r.match(ROOT_TOKEN_RE);
    return m ? path.join(base[m[1]], m[2] || '') : r;
  });
}

module.exports = {
  DEFAULT_ENVIRONMENT,
  BUILTIN_ENVIRONMENTS,
  EnvironmentProfileSchema,
  CredentialSchema,
  ENV_NAME_RE,
  loadEnvironment,
  environmentHash,
  toSandboxProfile,
  expandWriteRoots,
};
