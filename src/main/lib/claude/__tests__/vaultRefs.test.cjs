/**
 * vaultRefs.test.cjs — local vault refs (lib/claude/vaultRefs.cjs): keyring and
 * file resolution (stubbed), no network kinds, refusal of a ref not bound to an
 * out-of-job server, the environment schema's credentials list, the sandbox
 * denying every file: vault path, and the job env never carrying a value.
 *
 * Run: timeout 300 npx vitest run src/main/lib/claude/__tests__/vaultRefs.test.cjs
 */
'use strict';

import { describe, it, expect } from 'vitest';
const vault = require('../vaultRefs.cjs');
const { EnvironmentProfileSchema, BUILTIN_ENVIRONMENTS } = require('../environmentProfiles.cjs');
const { SANDBOX_SECRET_PATHS, buildJobSandboxSettings, sandboxChildEnv } = require('../jobSandboxPolicy.cjs');

const SECRET = 'sk-test-VALUE-123';

const profileWith = (credentials) => ({
  ...BUILTIN_ENVIRONMENTS['headless-default'],
  credentials,
});

describe('resolveVaultRef', () => {
  it('reads keyring: via secret-tool on linux (stubbed)', () => {
    const calls = [];
    const v = vault.resolveVaultRef('keyring:github/bot', {
      platform: 'linux',
      exec: (cmd, args) => { calls.push([cmd, args]); return `${SECRET}\n`; },
    });
    expect(v).toBe(SECRET);
    expect(calls).toEqual([['secret-tool', ['lookup', 'service', 'github', 'account', 'bot']]]);
  });

  it('reads keyring: via security on darwin (stubbed)', () => {
    const calls = [];
    const v = vault.resolveVaultRef('keyring:github/bot', {
      platform: 'darwin',
      exec: (cmd, args) => { calls.push([cmd, args]); return SECRET; },
    });
    expect(v).toBe(SECRET);
    expect(calls).toEqual([['security', ['find-generic-password', '-s', 'github', '-a', 'bot', '-w']]]);
  });

  it('refuses keyring on a platform without a keyring CLI', () => {
    expect(() => vault.resolveVaultRef('keyring:a/b', { platform: 'win32', exec: () => SECRET })).toThrow(/no OS keyring/);
  });

  it('reads file: whole file, JSON key, and KEY=VALUE key (stubbed)', () => {
    const reads = [];
    const files = {
      '/h/Self/secrets/token': `  ${SECRET}\n`,
      '/h/Self/secrets/all.json': JSON.stringify({ GH: SECRET, OTHER: 'x' }),
      '/h/Self/secrets/all.env': `# comment\nOTHER=x\nexport GH="${SECRET}"\n`,
    };
    const readFile = (p) => { reads.push(p); if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
    expect(vault.resolveVaultRef('file:Self/secrets/token', { homeDir: '/h', readFile })).toBe(SECRET);
    expect(vault.resolveVaultRef('file:~/Self/secrets/all.json#GH', { homeDir: '/h', readFile })).toBe(SECRET);
    expect(vault.resolveVaultRef('file:Self/secrets/all.env#GH', { homeDir: '/h', readFile })).toBe(SECRET);
    expect(() => vault.resolveVaultRef('file:Self/secrets/all.env#MISSING', { homeDir: '/h', readFile })).toThrow(/not found/);
    expect(() => vault.resolveVaultRef('file:Self/secrets/nope', { homeDir: '/h', readFile })).toThrow(/cannot read/);
    expect(reads.every((p) => p.startsWith('/h/Self/secrets/'))).toBe(true);
  });

  it('refuses network kinds and file paths outside the vault roots', () => {
    for (const bad of ['https://vault.example.com/x', 'vault:kv/x', 'file:/etc/passwd', 'file:Self/secrets/../.ssh/id', 'file:.ssh/id_rsa', 'keyring:nosep', '']) {
      expect(() => vault.parseVaultRef(bad)).toThrow(vault.VaultRefError);
    }
  });
});

describe('assertRefTargetsServer', () => {
  it('refuses a ref with no server', () => {
    const env = { profile: profileWith([{ ref: 'keyring:github/bot', server: '', envVar: 'GH_TOKEN' }]) };
    expect(() => vault.assertRefTargetsServer(env, { outOfJobServers: ['gh-broker'] })).toThrow(/names no server/);
    const missing = { profile: profileWith([{ ref: 'keyring:github/bot', envVar: 'GH_TOKEN' }]) };
    expect(() => vault.assertRefTargetsServer(missing, { outOfJobServers: ['gh-broker'] })).toThrow(/names no server/);
  });

  it('refuses a ref bound to a server that is not out-of-job', () => {
    const env = profileWith([{ ref: 'keyring:github/bot', server: 'in-job', envVar: 'GH_TOKEN' }]);
    expect(() => vault.assertRefTargetsServer(env, { outOfJobServers: ['gh-broker'] })).toThrow(/not an out-of-job server/);
    expect(() => vault.assertRefTargetsServer(env)).toThrow(/not an out-of-job server/);
  });

  it('passes a ref bound to an out-of-job server', () => {
    const env = profileWith([{ ref: 'keyring:github/bot', server: 'gh-broker', envVar: 'GH_TOKEN' }]);
    expect(vault.assertRefTargetsServer(env, { outOfJobServers: { 'gh-broker': {} } })).toHaveLength(1);
  });
});

describe('server spawn env vs job env', () => {
  const env = {
    id: 'headless-default',
    profile: profileWith([
      { ref: 'file:Self/secrets/gh#GH', server: 'gh-broker', envVar: 'GH_TOKEN' },
      { ref: 'keyring:other/acct', server: 'other-broker', envVar: 'OTHER_TOKEN' },
    ]),
  };
  const resolve = (ref) => (ref.startsWith('file:') ? SECRET : 'other-secret');

  it('resolves a ref only into its own server spawn env', () => {
    const spawnEnv = vault.serverSpawnEnv(env, 'gh-broker', {
      outOfJobServers: ['gh-broker', 'other-broker'],
      baseEnv: { PATH: '/bin' },
      resolve,
    });
    expect(spawnEnv).toEqual({ PATH: '/bin', GH_TOKEN: SECRET });
  });

  it('never puts the value in the job env', () => {
    const policy = buildJobSandboxSettings({
      agentType: 'dev-lead',
      environment: env,
      worktreeDir: '/h/wt',
      projectRoot: '/h/proj',
      homeDir: '/h',
      tmpDir: '/tmp/j',
      deps: { available: true },
    });
    const parent = { PATH: '/bin', GH_TOKEN: SECRET, OTHER_TOKEN: 'other-secret' };
    const jobEnv = { ...vault.jobEnvWithoutVault(env, parent), ...sandboxChildEnv(policy, '/tmp/j') };
    expect(Object.values(jobEnv)).not.toContain(SECRET);
    expect(JSON.stringify(jobEnv)).not.toContain(SECRET);
    expect(jobEnv).not.toHaveProperty('GH_TOKEN');
    expect(jobEnv).not.toHaveProperty('OTHER_TOKEN');
    expect(JSON.stringify(policy.argv)).not.toContain(SECRET);
  });
});

describe('schema + sandbox', () => {
  it('accepts credentials: [{ ref, server, envVar }] and refuses bad entries', () => {
    const ok = EnvironmentProfileSchema.safeParse(profileWith([{ ref: 'keyring:github/bot', server: 'gh-broker', envVar: 'GH_TOKEN' }]));
    expect(ok.success).toBe(true);
    for (const bad of [
      { ref: 'https://x/y', server: 's', envVar: 'A' },
      { ref: 'keyring:a/b', server: '', envVar: 'A' },
      { ref: 'keyring:a/b', server: 's', envVar: 'lower' },
      { ref: 'keyring:a/b', server: 's', envVar: 'A', extra: 1 },
    ]) {
      expect(EnvironmentProfileSchema.safeParse(profileWith([bad])).success).toBe(false);
    }
    expect(EnvironmentProfileSchema.safeParse(BUILTIN_ENVIRONMENTS['headless-default']).success).toBe(true);
  });

  it('SANDBOX_SECRET_PATHS covers every file: vault root', () => {
    for (const root of vault.VAULT_FILE_ROOTS) expect(SANDBOX_SECRET_PATHS).toContain(root);
    expect(SANDBOX_SECRET_PATHS).toContain('Self/secrets');
  });

  it('denies each file: credential path even when a profile omits it', () => {
    const env = {
      id: 'custom',
      profile: { ...profileWith([{ ref: 'file:Self/secrets/gh#GH', server: 'gh-broker', envVar: 'GH_TOKEN' }]), secretDenyPaths: ['.ssh'] },
    };
    const r = buildJobSandboxSettings({
      agentType: 'dev-lead', environment: env, worktreeDir: '/h/wt', projectRoot: '/h/proj', homeDir: '/h', tmpDir: '/tmp/j', deps: { available: true },
    });
    expect(r.settings.sandbox.filesystem.denyRead).toContain('/h/Self/secrets/gh');
    expect(r.settings.permissions.deny).toContain('Read(//h/Self/secrets/gh)');
  });
});
