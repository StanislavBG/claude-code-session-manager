'use strict';

/**
 * jobSandboxPolicy-environment.test.cjs — the job sandbox derives from the
 * resolved environment profile (environmentProfiles.cjs), and report mode
 * records what an environment would block without blocking it.
 *
 * Run: timeout 300 npx vitest run src/main/lib/claude/__tests__/jobSandboxPolicy-environment.test.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../jobSandboxPolicy.cjs');
const { BUILTIN_ENVIRONMENTS } = require('../environmentProfiles.cjs');
const schedulerConfig = require('../../scheduler/schedulerConfig.cjs');
const { decide } = require('../../../../../scripts/hooks/lib/guard-tool-risk-policy.cjs');

const { buildJobSandboxSettings, jobEnvironmentName, SANDBOX_SECRET_PATHS } = policy;

const BASE = Object.freeze({
  worktreeDir: '/home/u/wt/job-1',
  projectRoot: '/home/u/proj',
  homeDir: '/home/u',
  tmpDir: '/tmp/job-1',
});
const OK = Object.freeze({ available: true, missing: [] });
const builtin = (id) => ({ id, profile: BUILTIN_ENVIRONMENTS[id] });

/** The exact argv the retired persona-keyed SANDBOX_PROFILES produced. */
function legacyOsSandboxArgv(permissionMode, network) {
  const secretAbs = SANDBOX_SECRET_PATHS.map((p) => path.join('/home/u', p));
  const deny = secretAbs.flatMap((abs) => [`Read(/${abs})`, `Read(/${abs}/**)`, `Edit(/${abs})`, `Edit(/${abs}/**)`]);
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
        allowWrite: [
          '/home/u/wt/job-1', '/home/u/proj/.git', '/tmp/job-1', '/home/u/.npm', '/home/u/.cache',
          '/home/u/proj/node_modules/.vite', '/home/u/proj/node_modules/.vitest',
        ],
        denyRead: secretAbs,
      },
      credentials: { files: secretAbs.map((p) => ({ path: p, mode: 'deny' })) },
      network: { allowedDomains: network, strictAllowlist: true },
    },
  };
  return ['--permission-mode', permissionMode, '--settings', JSON.stringify(settings)];
}

describe('SANDBOX_PROFILES is gone', () => {
  it('the module no longer exports a persona-keyed profile table', () => {
    expect(policy.SANDBOX_PROFILES).toBeUndefined();
  });
});

describe('validator and dev-lead argv is unchanged', () => {
  it('validator → validator-readonly, byte-identical argv', () => {
    expect(jobEnvironmentName({ agentType: 'validator' })).toBe('validator-readonly');
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'validator', environment: builtin('validator-readonly'), deps: OK });
    expect(r.argv).toEqual(legacyOsSandboxArgv('default', []));
    expect(r.wouldBlock).toEqual([]);
  });

  it('dev-lead → headless-default, byte-identical argv', () => {
    expect(jobEnvironmentName({ agentType: 'dev-lead' })).toBe('headless-default');
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'dev-lead', environment: builtin('headless-default'), deps: OK });
    expect(r.argv).toEqual(legacyOsSandboxArgv('acceptEdits', ['registry.npmjs.org', 'api.github.com']));
  });

  it('other personas without a declared environment stay on tool rules', () => {
    expect(jobEnvironmentName({ agentType: 'architect' })).toBeNull();
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'architect', environment: null, deps: OK });
    expect(r.level).toBe('tool-rules');
    expect(r.argv[0]).toBe('--dangerously-skip-permissions');
    expect(r.wouldBlock).toEqual([]);
  });

  it('a declared environment beats the persona default', () => {
    expect(jobEnvironmentName({ agentType: 'validator', declared: 'open-web' })).toBe('open-web');
    expect(jobEnvironmentName({ agentType: 'architect', declared: ' headless-default ' })).toBe('headless-default');
  });
});

describe('profile-driven argv', () => {
  const custom = {
    osSandboxRequired: true,
    permissionMode: 'plan',
    writeRoots: ['{worktree}', '{home}/.gradle', '/opt/cache'],
    network: { mode: 'allowlist', hosts: ['example.com', '*.pypi.org'] },
    secretDenyPaths: ['.ssh'],
    webFetch: true,
    webSearch: false,
  };

  it('permission mode, write roots, network, secrets and web tools all come from the profile', () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'claude', environment: { id: 'mine', profile: custom }, deps: OK });
    expect(r.level).toBe('os-sandbox');
    expect(r.argv.slice(0, 3)).toEqual(['--permission-mode', 'plan', '--settings']);
    const s = JSON.parse(r.argv[3]);
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/home/u/wt/job-1', '/home/u/.gradle', '/opt/cache']);
    expect(s.sandbox.network).toEqual({ allowedDomains: ['example.com', '*.pypi.org'], strictAllowlist: true });
    expect(s.sandbox.filesystem.denyRead).toEqual(['/home/u/.ssh']);
    expect(s.permissions.deny).toEqual(['Read(//home/u/.ssh)', 'Read(//home/u/.ssh/**)', 'Edit(//home/u/.ssh)', 'Edit(//home/u/.ssh/**)', 'WebSearch']);
    expect(r.summary).toEqual({ level: 'os-sandbox', profile: 'claude', environment: 'mine', network: ['example.com', '*.pypi.org'], reason: null });
  });

  it("an 'open' network under the OS sandbox carries no allow-list", () => {
    const r = buildJobSandboxSettings({ ...BASE, environment: { id: 'o', profile: { ...custom, network: { mode: 'open' } } }, deps: OK });
    expect(r.settings.sandbox.network).toBeUndefined();
    expect(r.summary.network).toBeNull();
  });

  it('an environment that does not require the OS sandbox gets tool rules over its own secret list', () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'claude', environment: builtin('open-web'), deps: OK });
    expect(r.level).toBe('tool-rules');
    expect(r.summary.environment).toBe('open-web');
    expect(r.wouldBlock).toEqual([]);
  });
});

describe('report-mode would-block records', () => {
  it('scheduler config reads the mode: report on a fresh machine, env overrides both ways', () => {
    const prev = process.env.SM_ENVIRONMENT_ENFORCEMENT;
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-mode-')), 'scheduler-runtime-state.json');
    try {
      delete process.env.SM_ENVIRONMENT_ENFORCEMENT;
      expect(schedulerConfig.DEFAULT_ENVIRONMENT_ENFORCEMENT).toBe('report');
      expect(schedulerConfig.environmentEnforcement({ statePath })).toBe('report');
      process.env.SM_ENVIRONMENT_ENFORCEMENT = 'report';
      expect(schedulerConfig.environmentEnforcement({ statePath })).toBe('report');
      process.env.SM_ENVIRONMENT_ENFORCEMENT = 'enforce';
      expect(schedulerConfig.environmentEnforcement({ statePath })).toBe('enforce');
      process.env.SM_ENVIRONMENT_ENFORCEMENT = 'bogus';
      expect(schedulerConfig.environmentEnforcement({ statePath })).toBe('report');
    } finally {
      if (prev === undefined) delete process.env.SM_ENVIRONMENT_ENFORCEMENT;
      else process.env.SM_ENVIRONMENT_ENFORCEMENT = prev;
    }
  });

  it('report mode: sandbox required but unavailable → tool rules (not blocked) + one would-block entry', () => {
    const r = buildJobSandboxSettings({
      ...BASE, agentType: 'dev-lead', environment: builtin('headless-default'), deps: { available: false, missing: ['socat'] }, mode: 'report',
    });
    expect(r.level).toBe('tool-rules');
    expect(r.wouldBlock).toHaveLength(1);
    expect(r.wouldBlock[0].what).toBe('os_sandbox_unavailable');
    expect(r.wouldBlock[0].detail).toMatch(/socat/);
    expect(policy.wouldBlockRecord({ slug: 's-1', persona: 'dev-lead', environment: 'headless-default', ...r.wouldBlock[0], mode: 'report' }))
      .toEqual({ slug: 's-1', persona: 'dev-lead', environment: 'headless-default', what: 'os_sandbox_unavailable', detail: r.wouldBlock[0].detail, mode: 'report' });
  });

  it('webToolWouldBlock names disallowed tools and off-allow-list hosts', () => {
    const { webToolWouldBlock } = policy;
    const none = { webFetch: false, webSearch: false, network: { mode: 'none' } };
    expect(webToolWouldBlock(none, 'WebSearch', { query: 'q' })).toEqual({ what: 'websearch_not_allowed', detail: 'q' });
    expect(webToolWouldBlock(none, 'WebFetch', { url: 'https://a.com/x' })).toEqual({ what: 'webfetch_not_allowed', detail: 'https://a.com/x' });
    const allow = { webFetch: true, webSearch: true, network: { mode: 'allowlist', hosts: ['ok.com', '*.docs.io'] } };
    expect(webToolWouldBlock(allow, 'WebFetch', { url: 'https://ok.com/a' })).toBeNull();
    expect(webToolWouldBlock(allow, 'WebFetch', { url: 'https://x.docs.io/a' })).toBeNull();
    expect(webToolWouldBlock(allow, 'WebFetch', { url: 'https://evil.com/a' })).toEqual({ what: 'host_off_allowlist', detail: 'evil.com' });
    expect(webToolWouldBlock(allow, 'WebSearch', { query: 'q' })).toBeNull();
    expect(webToolWouldBlock({ ...allow, network: { mode: 'open' } }, 'WebFetch', { url: 'https://evil.com' })).toBeNull();
    expect(webToolWouldBlock(null, 'WebFetch', { url: 'https://evil.com' })).toBeNull();
    expect(webToolWouldBlock(none, 'Bash', { command: 'ls' })).toBeNull();
  });

  describe('the PreToolUse hook (guard-tool-risk) records and allows', () => {
    const hookEnv = (environment, extra = {}) => ({
      SM_SCHEDULER_JOB_SLUG: '3793-job',
      ...policy.environmentHookEnv({ environment, mode: 'report', agentType: 'dev-lead' }),
      ...extra,
    });
    const run = (env, tool_name, tool_input) => {
      const records = [];
      const out = decide({ tool_name, tool_input, cwd: '/nowhere' }, env, {
        homeDir: '/nonexistent-home-for-test',
        appendAuditEvent: (kind, fields) => records.push({ kind, ...fields }),
      });
      return { out, records };
    };

    it('a disallowed WebFetch appends one environment_would_block record and is not blocked', () => {
      const { out, records } = run(hookEnv(builtin('headless-default')), 'WebFetch', { url: 'https://example.com/a', prompt: 'p' });
      expect(out).toEqual({ continue: true });
      expect(records).toEqual([{
        kind: 'environment_would_block', slug: '3793-job', persona: 'dev-lead', environment: 'headless-default',
        what: 'webfetch_not_allowed', detail: 'https://example.com/a', mode: 'report',
      }]);
    });

    it('a disallowed WebSearch appends one record and is not blocked', () => {
      const { out, records } = run(hookEnv(builtin('validator-readonly')), 'WebSearch', { query: 'vitest' });
      expect(out).toEqual({ continue: true });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ environment: 'validator-readonly', what: 'websearch_not_allowed' });
    });

    it('an allowed call, a job with no environment, and an interactive session record nothing', () => {
      expect(run(hookEnv(builtin('open-web')), 'WebFetch', { url: 'https://a.com' }).records).toEqual([]);
      expect(run({ SM_SCHEDULER_JOB_SLUG: 'x' }, 'WebFetch', { url: 'https://a.com' }).records).toEqual([]);
      const interactive = hookEnv(builtin('headless-default'));
      delete interactive.SM_SCHEDULER_JOB_SLUG;
      expect(run(interactive, 'WebSearch', { query: 'q' }).records).toEqual([]);
    });

    it('environmentHookEnv carries the profile web rules and the mode', () => {
      const e = policy.environmentHookEnv({ environment: builtin('headless-default'), mode: 'enforce', agentType: 'dev-lead' });
      expect(JSON.parse(e.SM_JOB_ENVIRONMENT)).toEqual({
        id: 'headless-default', webFetch: false, webSearch: false, network: { mode: 'allowlist', hosts: ['registry.npmjs.org', 'api.github.com'] },
      });
      expect(e.SM_JOB_ENVIRONMENT_MODE).toBe('enforce');
      expect(e.SM_JOB_PERSONA).toBe('dev-lead');
      expect(policy.environmentHookEnv({ environment: null, mode: 'report' })).toEqual({});
    });
  });
});

describe('sandboxChildEnv NODE_USE_ENV_PROXY', () => {
  it('sets NODE_USE_ENV_PROXY=1 for an os-sandbox job with an allowlist network', () => {
    const env = policy.sandboxChildEnv({ level: 'os-sandbox', summary: { network: ['bilko.run'] } }, '/tmp/x');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.TMPDIR).toBe('/tmp/x');
  });
  it('omits it when there is no allowlist or the level is not os-sandbox', () => {
    expect(policy.sandboxChildEnv({ level: 'os-sandbox', summary: { network: [] } }, '/t').NODE_USE_ENV_PROXY).toBeUndefined();
    expect(policy.sandboxChildEnv({ level: 'os-sandbox', summary: { network: null } }, '/t').NODE_USE_ENV_PROXY).toBeUndefined();
    expect(policy.sandboxChildEnv({ level: 'tool-rules' }, '/t')).toEqual({});
  });
});
