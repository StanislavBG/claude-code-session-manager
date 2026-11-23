'use strict';
// @ts-check

/**
 * vaultRefs.cjs — local credential references for environment profiles
 * (Managed Agents' "vault" primitive, kept local).
 *
 * An environment may list `credentials: [{ ref, server, envVar }]`. Each ref
 * names a secret in a LOCAL store — never a network one:
 *   keyring:<service>/<account>   OS keyring (Linux `secret-tool lookup`,
 *                                 macOS `security find-generic-password -w`)
 *   file:<path>[#<KEY>]           a file under one of VAULT_FILE_ROOTS (home-
 *                                 relative, or `~/`-prefixed). With #KEY the
 *                                 file is read as a JSON object or KEY=VALUE
 *                                 lines; without, its trimmed contents.
 * Any other scheme (https:, vault:, …) is refused: 'vault_ref_invalid'.
 *
 * A resolved value goes ONLY into the spawn env of the MCP server / broker the
 * credential names, and only when that server runs OUTSIDE the job (the caller
 * says which servers do). It never enters the job env: jobEnvWithoutVault
 * strips every credential envVar from a job env, and jobSandboxPolicy.cjs
 * denies VAULT_FILE_ROOTS (plus each credential's file path) to the job.
 *
 * File stores are read only, never written. Self's secrets/README.md owns
 * its store's format; this module only reads paths under it.
 */

const path = require('node:path');

/** Home-relative roots a file: ref may point under (all job-denied). */
const VAULT_FILE_ROOTS = Object.freeze(['Self/secrets', '.config/session-manager/vault']);

const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;
const KEYRING_PART_RE = /^[A-Za-z0-9._@+-]+$/;

class VaultRefError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'VaultRefError';
    this.code = code;
  }
}

/**
 * @typedef {{ kind: 'keyring', service: string, account: string }
 *   | { kind: 'file', path: string, key: string|null }} ParsedVaultRef
 */

/**
 * Parse a ref string. file: paths come back home-relative and normalized.
 * @param {unknown} ref
 * @returns {ParsedVaultRef}
 */
function parseVaultRef(ref) {
  if (typeof ref !== 'string' || !ref) throw new VaultRefError('vault_ref_invalid', 'vault ref must be a non-empty string');
  const colon = ref.indexOf(':');
  const scheme = colon === -1 ? '' : ref.slice(0, colon);
  const body = colon === -1 ? '' : ref.slice(colon + 1);
  if (scheme === 'keyring') {
    const slash = body.indexOf('/');
    const service = slash === -1 ? '' : body.slice(0, slash);
    const account = slash === -1 ? '' : body.slice(slash + 1);
    if (!KEYRING_PART_RE.test(service) || !KEYRING_PART_RE.test(account)) {
      throw new VaultRefError('vault_ref_invalid', `keyring ref must be keyring:<service>/<account>: ${ref}`);
    }
    return { kind: 'keyring', service, account };
  }
  if (scheme === 'file') {
    const hash = body.indexOf('#');
    let p = hash === -1 ? body : body.slice(0, hash);
    const key = hash === -1 ? null : body.slice(hash + 1);
    if (key !== null && !key) throw new VaultRefError('vault_ref_invalid', `empty #key in ${ref}`);
    if (p.startsWith('~/')) p = p.slice(2);
    if (!p || path.isAbsolute(p) || p.split('/').includes('..')) {
      throw new VaultRefError('vault_ref_invalid', `file ref path must be home-relative without '..': ${ref}`);
    }
    const rel = path.posix.normalize(p);
    const under = VAULT_FILE_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
    if (!under) {
      throw new VaultRefError('vault_ref_invalid', `file ref must sit under ${VAULT_FILE_ROOTS.join(' or ')}: ${ref}`);
    }
    return { kind: 'file', path: rel, key };
  }
  throw new VaultRefError('vault_ref_invalid', `vault ref kind must be keyring: or file: (no network stores): ${ref}`);
}

/** True when `ref` parses. */
function isVaultRef(ref) {
  try {
    parseVaultRef(ref);
    return true;
  } catch {
    return false;
  }
}

/** Home-relative path of a file: ref, or null (keyring / invalid). */
function vaultFilePath(ref) {
  try {
    const p = parseVaultRef(ref);
    return p.kind === 'file' ? p.path : null;
  } catch {
    return null;
  }
}

/** @param {string} text @param {string} key */
function pickKey(text, key) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) return String(obj[key]);
      return null;
    } catch {
      /* fall through to KEY=VALUE */
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (m && m[1] === key) {
      let v = m[2].trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      return v;
    }
  }
  return null;
}

/**
 * Resolve a ref from its local store. Never touches the network.
 * @param {string} ref
 * @param {{ homeDir?: string, platform?: string,
 *   exec?: (cmd: string, args: string[]) => string,
 *   readFile?: (absPath: string) => string }} [opts] stubs for tests
 * @returns {string}
 */
function resolveVaultRef(ref, opts = {}) {
  const parsed = parseVaultRef(ref);
  let value;
  if (parsed.kind === 'keyring') {
    const platform = opts.platform || process.platform;
    const exec = opts.exec || ((cmd, args) => require('node:child_process').execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }));
    let cmd;
    let args;
    if (platform === 'linux') {
      cmd = 'secret-tool';
      args = ['lookup', 'service', parsed.service, 'account', parsed.account];
    } else if (platform === 'darwin') {
      cmd = 'security';
      args = ['find-generic-password', '-s', parsed.service, '-a', parsed.account, '-w'];
    } else {
      throw new VaultRefError('vault_ref_unsupported', `no OS keyring CLI on platform ${platform}`);
    }
    try {
      value = String(exec(cmd, args));
    } catch (e) {
      throw new VaultRefError('vault_ref_unresolved', `${cmd} could not read ${ref}: ${e && /** @type {Error} */ (e).message}`);
    }
    value = value.replace(/\r?\n$/, '');
  } else {
    const homeDir = opts.homeDir || require('node:os').homedir();
    const abs = path.join(homeDir, parsed.path);
    const readFile = opts.readFile || ((p) => require('node:fs').readFileSync(p, 'utf8'));
    let text;
    try {
      text = String(readFile(abs));
    } catch (e) {
      throw new VaultRefError('vault_ref_unresolved', `cannot read ${ref}: ${e && /** @type {Error} */ (e).message}`);
    }
    const picked = parsed.key === null ? text.trim() : pickKey(text, parsed.key);
    if (picked === null) throw new VaultRefError('vault_ref_unresolved', `key ${parsed.key} not found in ${ref}`);
    value = picked;
  }
  if (!value) throw new VaultRefError('vault_ref_empty', `vault ref resolved empty: ${ref}`);
  return value;
}

/**
 * @typedef {{ ref: string, server: string, envVar: string }} VaultCredential
 */

/** The credentials list of a profile or resolved environment ({ profile }). */
function credentialsOf(environment) {
  if (!environment || typeof environment !== 'object') return [];
  const e = /** @type {any} */ (environment);
  const profile = e.profile && typeof e.profile === 'object' ? e.profile : e;
  return Array.isArray(profile.credentials) ? /** @type {VaultCredential[]} */ (profile.credentials) : [];
}

/** @param {Iterable<string>|Record<string, unknown>|null|undefined} s */
function toNameSet(s) {
  if (!s) return new Set();
  if (typeof (/** @type {any} */ (s))[Symbol.iterator] === 'function') return new Set(Array.from(/** @type {Iterable<string>} */ (s), String));
  return new Set(Object.keys(s));
}

/**
 * Refuse any credential not bound to an out-of-job MCP server / broker.
 * Throws VaultRefError 'vault_ref_unbound' (no server, or a server that runs
 * inside the job / is unknown), or 'vault_ref_invalid' (bad ref / envVar).
 * @param {object|null|undefined} environment profile or resolved environment
 * @param {{ outOfJobServers?: Iterable<string>|Record<string, unknown>|null }} [opts]
 * @returns {VaultCredential[]} the checked credentials
 */
function assertRefTargetsServer(environment, { outOfJobServers } = {}) {
  const allowed = toNameSet(outOfJobServers);
  const creds = credentialsOf(environment);
  for (const c of creds) {
    const ref = c && c.ref;
    parseVaultRef(ref);
    const server = c && typeof c.server === 'string' ? c.server.trim() : '';
    if (!server) throw new VaultRefError('vault_ref_unbound', `vault ref ${ref} names no server — refs resolve only into an out-of-job MCP server`);
    if (!allowed.has(server)) throw new VaultRefError('vault_ref_unbound', `vault ref ${ref} targets ${server}, which is not an out-of-job server`);
    if (!c || typeof c.envVar !== 'string' || !ENV_VAR_RE.test(c.envVar)) throw new VaultRefError('vault_ref_invalid', `vault ref ${ref} needs an envVar like API_TOKEN`);
  }
  return creds;
}

/**
 * The spawn env for one out-of-job MCP server: baseEnv plus the resolved
 * values of the credentials bound to it (and no other server's).
 * @param {object|null|undefined} environment
 * @param {string} serverName
 * @param {{ outOfJobServers?: Iterable<string>|Record<string, unknown>|null,
 *   baseEnv?: Record<string, string|undefined>,
 *   resolve?: (ref: string) => string }} [opts]
 * @returns {Record<string, string|undefined>}
 */
function serverSpawnEnv(environment, serverName, { outOfJobServers, baseEnv = {}, resolve = (r) => resolveVaultRef(r) } = {}) {
  const creds = assertRefTargetsServer(environment, { outOfJobServers });
  const env = { ...baseEnv };
  for (const c of creds) {
    if (c.server.trim() === serverName) env[c.envVar] = resolve(c.ref);
  }
  return env;
}

/**
 * A job env with every credential envVar removed, so no vault value (or a
 * same-named parent value) reaches the job.
 * @param {object|null|undefined} environment
 * @param {Record<string, string|undefined>} jobEnv
 * @returns {Record<string, string|undefined>}
 */
function jobEnvWithoutVault(environment, jobEnv) {
  const env = { ...(jobEnv || {}) };
  for (const c of credentialsOf(environment)) {
    if (c && typeof c.envVar === 'string') delete env[c.envVar];
  }
  return env;
}

/** Home-relative file paths of an environment's file: credentials. */
function credentialFilePaths(environment) {
  /** @type {string[]} */
  const out = [];
  for (const c of credentialsOf(environment)) {
    const p = vaultFilePath(c && c.ref);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

module.exports = {
  VAULT_FILE_ROOTS,
  VaultRefError,
  parseVaultRef,
  isVaultRef,
  vaultFilePath,
  resolveVaultRef,
  assertRefTargetsServer,
  serverSpawnEnv,
  jobEnvWithoutVault,
  credentialFilePaths,
};
