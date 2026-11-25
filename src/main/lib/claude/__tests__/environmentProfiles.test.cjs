/**
 * environmentProfiles.test.cjs — declared environment profiles
 * (lib/claude/environmentProfiles.cjs): built-ins, global + project overlay
 * precedence, zod-strict refusal of an invalid file, unknown-name refusal,
 * content hash, and the persona/snapshot wiring.
 *
 * Run: timeout 300 npx vitest run src/main/lib/claude/__tests__/environmentProfiles.test.cjs
 */
'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../environmentProfiles.cjs');
const { SANDBOX_SECRET_PATHS } = require('../jobSandboxPolicy.cjs');

// The sandbox settings validator and dev-lead had under the retired SANDBOX_PROFILES.
const SANDBOX_PROFILES = Object.freeze({
  validator: { permissionMode: 'default', network: [] },
  'dev-lead': { permissionMode: 'acceptEdits', network: ['registry.npmjs.org', 'api.github.com'] },
});
const { validatePersonaFrontmatter } = require('../../persona-macro/personaFrontmatterSchema.cjs');
const { MANAGED_PERSONA_KEYS } = require('../../../agentLibrary.cjs');

let cwd;
let home;

const custom = (over = {}) => ({
  description: 'custom',
  osSandboxRequired: true,
  permissionMode: 'acceptEdits',
  writeRoots: ['{worktree}', '{tmp}'],
  network: { mode: 'allowlist', hosts: ['example.com'] },
  secretDenyPaths: ['.ssh'],
  webFetch: false,
  webSearch: false,
  ...over,
});

function writeEnv(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), typeof value === 'string' ? value : JSON.stringify(value));
}
const globalDir = () => path.join(home, '.claude', 'session-manager', 'environments');
const projectDir = () => path.join(cwd, '.claude', 'environments');

beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-env-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-env-home-')));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('built-in profiles', () => {
  it('ships headless-default, validator-readonly and open-web', () => {
    for (const name of ['headless-default', 'validator-readonly', 'open-web']) {
      const r = env.loadEnvironment({ cwd, name });
      expect(r.code).toBeUndefined();
      expect(r.id).toBe(name);
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.source).toBe('builtin');
      expect(env.EnvironmentProfileSchema.safeParse(r.profile).success).toBe(true);
    }
    expect(env.DEFAULT_ENVIRONMENT).toBe('headless-default');
  });

  it('a missing name resolves to headless-default', () => {
    expect(env.loadEnvironment({ cwd }).id).toBe('headless-default');
  });

  it('headless-default reproduces the dev-lead SANDBOX_PROFILE (OS sandbox + allow-list)', () => {
    const { profile } = env.loadEnvironment({ cwd, name: 'headless-default' });
    expect(profile.osSandboxRequired).toBe(true);
    expect(profile.network).toEqual({ mode: 'allowlist', hosts: ['registry.npmjs.org', 'api.github.com'] });
    expect(env.toSandboxProfile(profile)).toEqual({ ...SANDBOX_PROFILES['dev-lead'], network: [...SANDBOX_PROFILES['dev-lead'].network] });
    expect(profile.secretDenyPaths).toEqual([...SANDBOX_SECRET_PATHS]);
    expect(profile.webFetch).toBe(false);
    expect(profile.webSearch).toBe(false);
  });

  it('headless-default allowlists api.github.com and stays in allowlist mode', () => {
    const { profile } = env.loadEnvironment({ cwd, name: 'headless-default' });
    expect(profile.network.mode).toBe('allowlist');
    expect(profile.network.hosts).toContain('api.github.com');
  });

  it('validator-readonly reproduces the validator SANDBOX_PROFILE', () => {
    const { profile } = env.loadEnvironment({ cwd, name: 'validator-readonly' });
    expect(profile.network).toEqual({ mode: 'none' });
    expect(env.toSandboxProfile(profile)).toEqual({ ...SANDBOX_PROFILES.validator, network: [] });
    expect(profile.secretDenyPaths).toEqual([...SANDBOX_SECRET_PATHS]);
  });

  it('open-web allows the web and does not require the OS sandbox', () => {
    const { profile } = env.loadEnvironment({ cwd, name: 'open-web' });
    expect(profile.network).toEqual({ mode: 'open' });
    expect(profile.webFetch).toBe(true);
    expect(profile.webSearch).toBe(true);
    expect(profile.osSandboxRequired).toBe(false);
    expect(env.toSandboxProfile(profile).network).toBeNull();
  });

  it('write roots expand to today\'s allowWrite list', () => {
    const { profile } = env.loadEnvironment({ cwd, name: 'headless-default' });
    const roots = env.expandWriteRoots(profile, { worktreeDir: '/w', projectRoot: '/p', homeDir: '/h', tmpDir: '/t' });
    expect(roots).toEqual(['/w', '/p/.git', '/t', '/h/.npm', '/h/.cache', '/p/node_modules/.vite', '/p/node_modules/.vitest']);
  });
});

describe('files + overlay', () => {
  it('reads a global file', () => {
    writeEnv(globalDir(), 'mine', custom());
    const r = env.loadEnvironment({ cwd, name: 'mine' });
    expect(r.id).toBe('mine');
    expect(r.source).toBe('global');
    expect(r.profile.network.hosts).toEqual(['example.com']);
  });

  it('project file wins over global and built-in', () => {
    writeEnv(globalDir(), 'mine', custom({ description: 'global' }));
    writeEnv(projectDir(), 'mine', custom({ description: 'project' }));
    const r = env.loadEnvironment({ cwd, name: 'mine' });
    expect(r.source).toBe('project');
    expect(r.profile.description).toBe('project');

    writeEnv(globalDir(), 'headless-default', custom({ description: 'global-hd' }));
    expect(env.loadEnvironment({ cwd, name: 'headless-default' }).profile.description).toBe('global-hd');
    writeEnv(projectDir(), 'headless-default', custom({ description: 'project-hd' }));
    expect(env.loadEnvironment({ cwd, name: 'headless-default' }).profile.description).toBe('project-hd');
  });

  it('refuses an invalid file (unknown key, bad shape, bad JSON) instead of falling back', () => {
    writeEnv(globalDir(), 'mine', custom());
    for (const bad of [
      { ...custom(), extra: 1 },
      custom({ network: { mode: 'allowlist' } }),
      custom({ network: { mode: 'none', hosts: ['x.com'] } }),
      custom({ writeRoots: ['relative/path'] }),
      custom({ secretDenyPaths: ['/abs'] }),
      '{ not json',
    ]) {
      writeEnv(projectDir(), 'mine', bad);
      const r = env.loadEnvironment({ cwd, name: 'mine' });
      expect(r.code).toBe('environment_invalid');
      expect(r.name).toBe('mine');
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.profile).toBeUndefined();
    }
  });

  it('refuses an unknown name', () => {
    expect(env.loadEnvironment({ cwd, name: 'nope' })).toEqual({ code: 'environment_unknown', name: 'nope' });
    expect(env.loadEnvironment({ cwd, name: '../escape' })).toEqual({ code: 'environment_unknown', name: '../escape' });
  });

  it('hash changes on edit and is stable otherwise', () => {
    writeEnv(projectDir(), 'mine', custom());
    const a = env.loadEnvironment({ cwd, name: 'mine' }).hash;
    // Key order does not matter (canonical JSON).
    const reordered = Object.fromEntries(Object.entries(custom()).reverse());
    writeEnv(projectDir(), 'mine', reordered);
    expect(env.loadEnvironment({ cwd, name: 'mine' }).hash).toBe(a);
    writeEnv(projectDir(), 'mine', custom({ webFetch: true }));
    expect(env.loadEnvironment({ cwd, name: 'mine' }).hash).not.toBe(a);
  });
});

describe('persona + snapshot wiring', () => {
  it('persona frontmatter accepts `environment` and it is a managed key', () => {
    expect(MANAGED_PERSONA_KEYS.has('environment')).toBe(true);
    expect(validatePersonaFrontmatter({ name: 'x', model: 'sonnet', environment: 'open-web' })).toEqual({ ok: true });
    expect(validatePersonaFrontmatter({ name: 'x', model: 'sonnet', environment: 'Bad Name' }).ok).toBe(false);
  });

  it('the agent snapshot records the environment id and hash', async () => {
    require('../../../config.cjs').addAllowedRoot(cwd);
    const dir = path.join(cwd, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const write = (extra) => fs.writeFileSync(
      path.join(dir, 'env-tester.md'),
      `---\nname: env-tester\ndescription: t\nmodel: sonnet\ntools: Read\n${extra}---\n\nbody\n`,
    );
    const snap = require('../agentSnapshot.cjs');

    write('');
    const def = await snap.buildAgentSnapshot({ cwd, agentType: 'env-tester' });
    expect(def.refusal).toBeNull();
    expect(def.snapshot.environment).toEqual({ id: 'headless-default', hash: env.loadEnvironment({ cwd, name: 'headless-default' }).hash });

    write('environment: open-web\n');
    const web = await snap.buildAgentSnapshot({ cwd, agentType: 'env-tester' });
    expect(web.snapshot.environment.id).toBe('open-web');
    expect(web.id).not.toBe(def.id);

    write('environment: missing-env\n');
    const bad = await snap.buildAgentSnapshot({ cwd, agentType: 'env-tester' });
    expect(bad.id).toBeNull();
    expect(bad.refusal.code).toBe('environment_unknown');
  });
});
