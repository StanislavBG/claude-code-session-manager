'use strict';

/**
 * environmentEnforce.test.cjs — enforcement is the default (PRD 3805): a
 * sandbox-required environment without its OS sandbox is refused (never
 * downgraded to tool rules) and the scheduler parks it
 * 'environment_unavailable: <missing deps>'; the guard hook denies
 * WebFetch/WebSearch the environment disallows; open-web personas declare it;
 * the readiness banner names the packages to install.
 *
 * Run: timeout 300 npx vitest run src/main/lib/claude/__tests__/environmentEnforce.test.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const policy = require('../jobSandboxPolicy.cjs');
const { BUILTIN_ENVIRONMENTS } = require('../environmentProfiles.cjs');
const schedulerConfig = require('../../scheduler/schedulerConfig.cjs');
const { checkJobSandbox } = require('../../epic/delegationReadiness.cjs');
const { decide } = require('../../../../../scripts/hooks/lib/guard-tool-risk-policy.cjs');

const { buildJobSandboxSettings } = policy;
const BASE = Object.freeze({ worktreeDir: '/home/u/wt/job-1', projectRoot: '/home/u/proj', homeDir: '/home/u', tmpDir: '/tmp/job-1' });
const builtin = (id) => ({ id, profile: BUILTIN_ENVIRONMENTS[id] });
const MISSING = Object.freeze({ available: false, missing: ['bwrap', 'socat'] });

function withEnv(key, value, fn) {
  const prev = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('enforcement is the default', () => {
  it("scheduler config defaults to 'enforce'; only an explicit 'report' opts out", () => {
    expect(schedulerConfig.DEFAULT_ENVIRONMENT_ENFORCEMENT).toBe('enforce');
    withEnv('SM_ENVIRONMENT_ENFORCEMENT', undefined, () => expect(schedulerConfig.environmentEnforcement()).toBe('enforce'));
    withEnv('SM_ENVIRONMENT_ENFORCEMENT', 'bogus', () => expect(schedulerConfig.environmentEnforcement()).toBe('enforce'));
    withEnv('SM_ENVIRONMENT_ENFORCEMENT', 'report', () => expect(schedulerConfig.environmentEnforcement()).toBe('report'));
  });
});

describe('park on missing deps, no downgrade', () => {
  for (const [agentType, envId] of [['dev-lead', 'headless-default'], ['validator', 'validator-readonly']]) {
    it(`${envId} without its OS sandbox is refused environment_unavailable, never tool rules`, () => {
      for (const mode of [undefined, 'enforce']) {
        const r = buildJobSandboxSettings({ ...BASE, agentType, environment: builtin(envId), deps: MISSING, mode });
        expect(r.level).toBe('refused');
        expect(r.level).not.toBe('tool-rules');
        expect(r.argv).toEqual([]);
        expect(r.argv).not.toContain('--dangerously-skip-permissions');
        expect(r.refusal).toEqual({ code: 'environment_unavailable', detail: 'bwrap, socat', missing: ['bwrap', 'socat'] });
        expect(r.summary.environment).toBe(envId);
        expect(`${r.refusal.code}: ${r.refusal.detail}`).toBe('environment_unavailable: bwrap, socat');
      }
    });
  }

  it('missing deps with no named dependency still refuse, naming unknown', () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'dev-lead', environment: builtin('headless-default'), deps: null });
    expect(r.refusal).toMatchObject({ code: 'environment_unavailable', detail: 'unknown' });
  });

  it('environments that do not need the OS sandbox, and jobs with none, are not refused', () => {
    const open = buildJobSandboxSettings({ ...BASE, agentType: 'competitive-analyst', environment: builtin('open-web'), deps: MISSING });
    expect(open.level).toBe('tool-rules');
    expect(open.refusal).toBeNull();
    const none = buildJobSandboxSettings({ ...BASE, agentType: 'architect', environment: null, deps: MISSING });
    expect(none.level).toBe('tool-rules');
    expect(none.refusal).toBeNull();
  });

  it("'report' mode keeps the downgrade as an explicit opt-out", () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'dev-lead', environment: builtin('headless-default'), deps: MISSING, mode: 'report' });
    expect(r.level).toBe('tool-rules');
    expect(r.refusal).toBeNull();
    expect(r.wouldBlock).toHaveLength(1);
  });

  it('available deps still get the OS sandbox', () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'dev-lead', environment: builtin('headless-default'), deps: { available: true, missing: [] } });
    expect(r.level).toBe('os-sandbox');
    expect(r.refusal).toBeNull();
  });

  it('the scheduler parks the refusal through transitionJob with the environment_unavailable reason', () => {
    const scheduler = require('../../../scheduler.cjs');
    const row = { slug: '9999-x', status: 'running', runtime: { pid: 1 } };
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'dev-lead', environment: builtin('headless-default'), deps: { available: false, missing: ['socat'] } });
    expect(scheduler.applyPersonaRefusalPark(row, { code: r.refusal.code, detail: r.refusal.detail })).toBe(true);
    expect(row.status).toBe('needs_review');
    expect(row.error).toBe('environment_unavailable: socat');
    expect(row.terminalReason).toBe('environment_unavailable');
    expect(row.runtime).toBeUndefined();
    // executeJob wires the refusal into the same personaRefusal park path, before spawn.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scheduler.cjs'), 'utf8');
    expect(src).toMatch(/mode: enforcementMode,\s*\}\);\s*\/\/ Enforce mode[\s\S]*?if \(sandboxPolicy\.refusal\)[\s\S]*?personaRefusal: \{ code, detail \} \}\);\s*return;/);
  });
});

describe('web tools denied/allowed by environment (guard-tool-risk)', () => {
  const hookEnv = (environment, mode) => ({
    SM_SCHEDULER_JOB_SLUG: '3805-job',
    ...policy.environmentHookEnv({ environment, mode, agentType: 'dev-lead' }),
  });
  const run = (env, tool_name, tool_input) => {
    const records = [];
    const out = decide({ tool_name, tool_input, cwd: '/nowhere' }, env, {
      homeDir: '/nonexistent-home-for-test',
      appendAuditEvent: (kind, fields) => records.push({ kind, ...fields }),
    });
    return { out, records };
  };
  const denied = (out) => out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny';

  it('the hook env defaults to enforce', () => {
    expect(policy.environmentHookEnv({ environment: builtin('headless-default'), mode: undefined }).SM_JOB_ENVIRONMENT_MODE).toBe('enforce');
  });

  it('WebFetch is denied in headless-default, naming the environment', () => {
    const { out, records } = run(hookEnv(builtin('headless-default'), 'enforce'), 'WebFetch', { url: 'https://example.com/a', prompt: 'p' });
    expect(denied(out)).toBe(true);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/environment 'headless-default' does not allow WebFetch/);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/environment: open-web/);
    expect(records).toEqual([{
      kind: 'environment_would_block', slug: '3805-job', persona: 'dev-lead', environment: 'headless-default',
      what: 'webfetch_not_allowed', detail: 'https://example.com/a', mode: 'enforce',
    }]);
  });

  it('WebSearch is denied in validator-readonly, naming the environment', () => {
    const { out } = run(hookEnv(builtin('validator-readonly'), 'enforce'), 'WebSearch', { query: 'vitest' });
    expect(denied(out)).toBe(true);
    expect(out.reason).toMatch(/environment 'validator-readonly' does not allow WebSearch/);
  });

  it('a host off the allow-list is denied, naming host and environment', () => {
    const env = { id: 'docs-only', profile: { ...BUILTIN_ENVIRONMENTS['headless-default'], webFetch: true, network: { mode: 'allowlist', hosts: ['docs.io'] } } };
    const ok = run(hookEnv(env, 'enforce'), 'WebFetch', { url: 'https://docs.io/a' });
    expect(ok.out).toEqual({ continue: true });
    const bad = run(hookEnv(env, 'enforce'), 'WebFetch', { url: 'https://evil.com/a' });
    expect(denied(bad.out)).toBe(true);
    expect(bad.out.reason).toMatch(/evil\.com.*'docs-only'/);
  });

  it('open-web allows WebFetch and WebSearch', () => {
    const env = hookEnv(builtin('open-web'), 'enforce');
    expect(run(env, 'WebFetch', { url: 'https://a.com' })).toEqual({ out: { continue: true }, records: [] });
    expect(run(env, 'WebSearch', { query: 'q' })).toEqual({ out: { continue: true }, records: [] });
  });

  it("'report' mode records but allows; no environment or interactive allows", () => {
    const rep = run(hookEnv(builtin('headless-default'), 'report'), 'WebSearch', { query: 'q' });
    expect(rep.out).toEqual({ continue: true });
    expect(rep.records).toHaveLength(1);
    expect(run({ SM_SCHEDULER_JOB_SLUG: 'x' }, 'WebFetch', { url: 'https://a.com' }).out).toEqual({ continue: true });
    const interactive = hookEnv(builtin('headless-default'), 'enforce');
    delete interactive.SM_SCHEDULER_JOB_SLUG;
    expect(run(interactive, 'WebFetch', { url: 'https://a.com' }).out).toEqual({ continue: true });
  });
});

describe('seed personas with web tools declare environment: open-web', () => {
  const { splitFrontmatter } = require('../../prd/prdFrontmatter.cjs');
  const dir = path.join(__dirname, '..', '..', '..', '..', 'seed', 'agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

  it('competitive-researcher and competitive-analyst declare open-web', () => {
    for (const name of ['competitive-researcher', 'competitive-analyst']) {
      const { fm } = splitFrontmatter(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8'));
      expect(fm.environment).toBe('open-web');
    }
  });

  it('every seed persona whose tools include WebFetch/WebSearch declares open-web', () => {
    for (const f of files) {
      const { fm } = splitFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (/\bWeb(Fetch|Search)\b/.test(String(fm.tools || ''))) expect([f, fm.environment]).toEqual([f, 'open-web']);
    }
  });
});

describe('readiness banner names the missing sandbox packages', () => {
  it('linux: names bubblewrap/socat and the apt line under enforce', () => {
    const c = checkJobSandbox({ sandboxDeps: MISSING, platform: 'linux', mode: 'enforce' });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/bwrap, socat/);
    expect(c.detail).toMatch(/environment_unavailable/);
    expect(c.fix).toMatch(/bubblewrap, socat/);
    expect(c.fix).toMatch(/sudo apt install bubblewrap socat/);
  });

  it('only socat missing names only socat', () => {
    const c = checkJobSandbox({ sandboxDeps: { available: false, missing: ['socat'] }, platform: 'linux', mode: 'enforce' });
    expect(c.fix).toMatch(/Install socat \(sudo apt install socat\)/);
  });

  it('deps present → ok; report mode → ok with a warning', () => {
    expect(checkJobSandbox({ sandboxDeps: { available: true, missing: [] }, platform: 'linux', mode: 'enforce' }).ok).toBe(true);
    const r = checkJobSandbox({ sandboxDeps: MISSING, platform: 'linux', mode: 'report' });
    expect(r.ok).toBe(true);
    expect(r.warn).toBe(true);
  });

  it('sandboxInstallHint is pure and platform-aware', () => {
    expect(policy.sandboxInstallHint({ platform: 'linux', missing: ['bwrap'] })).toEqual({ packages: ['bubblewrap'], command: 'sudo apt install bubblewrap' });
    expect(policy.sandboxInstallHint({ platform: 'win32', missing: ['unsupported platform: win32'] })).toEqual({ packages: [], command: null });
  });
});
