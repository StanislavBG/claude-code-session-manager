'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/jobSandboxPolicy.test.cjs

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  SANDBOX_SECRET_PATHS,
  LEGACY_PERSONA_ENVIRONMENTS,
  jobEnvironmentName,
  sandboxDependencies,
  buildJobSandboxSettings,
  sandboxChildEnv,
} = require('../jobSandboxPolicy.cjs');
const { BUILTIN_ENVIRONMENTS } = require('../environmentProfiles.cjs');

// The sandbox settings validator and dev-lead had under the retired SANDBOX_PROFILES.
const LEGACY = Object.freeze({
  validator: { permissionMode: 'default', network: [] },
  'dev-lead': { permissionMode: 'acceptEdits', network: ['registry.npmjs.org', 'api.github.com'] },
});
/** @param {string|undefined} agentType */
function envFor(agentType) {
  const id = jobEnvironmentName({ agentType });
  return id ? { id, profile: BUILTIN_ENVIRONMENTS[id] } : null;
}

const BASE = Object.freeze({
  worktreeDir: '/home/u/wt/job-1',
  projectRoot: '/home/u/proj',
  homeDir: '/home/u',
  tmpDir: '/tmp/job-1',
});
const OK_DEPS = Object.freeze({ available: true, missing: [] });

function expectedDeny() {
  const out = [];
  for (const p of SANDBOX_SECRET_PATHS) {
    const abs = path.join('/home/u', p);
    out.push(`Read(/${abs})`, `Read(/${abs}/**)`, `Edit(/${abs})`, `Edit(/${abs}/**)`);
  }
  return out;
}

describe('module shape', () => {
  it('freezes the secret list and the profiles, nested too', () => {
    assert.ok(Object.isFrozen(SANDBOX_SECRET_PATHS));
    assert.ok(SANDBOX_SECRET_PATHS.includes('.npmrc'));
    assert.ok(SANDBOX_SECRET_PATHS.includes('.ssh'));
    assert.ok(SANDBOX_SECRET_PATHS.includes('Self/secrets'));
    assert.ok(Object.isFrozen(LEGACY_PERSONA_ENVIRONMENTS));
    assert.deepEqual(LEGACY_PERSONA_ENVIRONMENTS, { validator: 'validator-readonly', 'dev-lead': 'headless-default' });
  });
});

describe('deny rules', () => {
  it('emits four double-slash rules per secret path', () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'claude', deps: OK_DEPS });
    const deny = r.settings.permissions.deny;
    assert.equal(deny.length, SANDBOX_SECRET_PATHS.length * 4);
    assert.deepEqual(deny, expectedDeny());
    assert.ok(deny.includes('Read(//home/u/.npmrc)'));
    assert.ok(deny.includes('Read(//home/u/.ssh/**)'));
    assert.ok(deny.includes('Edit(//home/u/Self/secrets)'));
    assert.ok(deny.includes('Edit(//home/u/.claude/.credentials.json/**)'));
    for (const rule of deny) assert.match(rule, /^(Read|Edit)\(\/\/home\/u\//);
  });
});

describe('os-sandbox profiles', () => {
  for (const agentType of ['validator', 'dev-lead']) {
    it(`${agentType} gets the OS sandbox`, () => {
      const profile = LEGACY[agentType];
      const r = buildJobSandboxSettings({ ...BASE, agentType, environment: envFor(agentType), deps: OK_DEPS });
      assert.equal(r.level, 'os-sandbox');
      assert.equal(r.argv.length, 4);
      assert.deepEqual(r.argv.slice(0, 3), ['--permission-mode', profile.permissionMode, '--settings']);
      assert.ok(!r.argv.includes('--dangerously-skip-permissions'));
      assert.deepEqual(JSON.parse(r.argv[3]), r.settings);

      const sb = r.settings.sandbox;
      assert.equal(sb.enabled, true);
      assert.equal(sb.failIfUnavailable, true);
      assert.equal(sb.allowUnsandboxedCommands, false);
      assert.equal(sb.autoAllowBashIfSandboxed, true);
      assert.equal(sb.network.strictAllowlist, true);
      assert.deepEqual(sb.network.allowedDomains, [...profile.network]);

      const secretAbs = SANDBOX_SECRET_PATHS.map((p) => path.join('/home/u', p));
      assert.deepEqual(sb.filesystem.denyRead, secretAbs);
      assert.deepEqual(sb.filesystem.allowWrite, [
        '/home/u/wt/job-1',
        '/home/u/proj/.git',
        '/tmp/job-1',
        '/home/u/.npm',
        '/home/u/.cache',
        '/home/u/proj/node_modules/.vite',
        '/home/u/proj/node_modules/.vitest',
      ]);
      assert.deepEqual(sb.credentials.files, secretAbs.map((p) => ({ path: p, mode: 'deny' })));

      assert.deepEqual(r.settings.permissions.allow, [
        'Read(//**)', 'Glob', 'Grep', 'Bash', 'Skill', 'Agent', 'ToolSearch', 'TodoWrite',
      ]);
      assert.deepEqual(r.settings.permissions.deny, [...expectedDeny(), 'WebFetch', 'WebSearch']);

      assert.deepEqual(r.summary, {
        level: 'os-sandbox',
        profile: agentType,
        environment: LEGACY_PERSONA_ENVIRONMENTS[agentType],
        network: [...profile.network],
        reason: null,
      });
      assert.deepEqual(r.wouldBlock, []);
    });
  }
});

describe('tool-rules fallback', () => {
  it('a persona without a profile gets tool rules and a reason', () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'architect', deps: OK_DEPS });
    assert.equal(r.level, 'tool-rules');
    assert.deepEqual(r.argv.slice(0, 2), ['--dangerously-skip-permissions', '--settings']);
    assert.equal(r.argv.length, 3);
    assert.deepEqual(JSON.parse(r.argv[2]), r.settings);
    assert.deepEqual(Object.keys(r.settings), ['permissions']);
    assert.deepEqual(Object.keys(r.settings.permissions), ['deny']);
    assert.deepEqual(r.settings.permissions.deny, expectedDeny());
    assert.equal(r.summary.level, 'tool-rules');
    assert.equal(r.summary.network, null);
    assert.match(r.summary.reason, /no environment profile/);
    assert.match(r.summary.reason, /architect/);
  });

  it('a missing agentType falls back with profile null', () => {
    const r = buildJobSandboxSettings({ ...BASE, deps: OK_DEPS });
    assert.equal(r.level, 'tool-rules');
    assert.equal(r.summary.profile, null);
    assert.match(r.summary.reason, /no environment profile/);
  });

  it("report mode: missing dependencies downgrade a profiled persona and name them", () => {
    const r = buildJobSandboxSettings({
      ...BASE,
      agentType: 'dev-lead',
      environment: envFor('dev-lead'),
      deps: { available: false, missing: ['socat'] },
      mode: 'report',
    });
    assert.equal(r.level, 'tool-rules');
    assert.equal(r.argv[0], '--dangerously-skip-permissions');
    assert.equal(r.settings.sandbox, undefined);
    assert.equal(r.summary.profile, 'dev-lead');
    assert.match(r.summary.reason, /socat/);
  });

  it('absent deps is treated as unavailable (report mode → tool rules; enforce → refused)', () => {
    const r = buildJobSandboxSettings({ ...BASE, agentType: 'validator', environment: envFor('validator'), mode: 'report' });
    assert.equal(r.level, 'tool-rules');
    assert.equal(buildJobSandboxSettings({ ...BASE, agentType: 'validator', environment: envFor('validator') }).level, 'refused');
    assert.equal(typeof r.summary.reason, 'string');
  });
});

describe('sandboxDependencies', () => {
  const whichOf = (present) => (name) => (present.includes(name) ? `/usr/bin/${name}` : null);

  it('linux needs bwrap and socat', () => {
    assert.deepEqual(sandboxDependencies({ platform: 'linux', which: whichOf(['bwrap', 'socat']) }), {
      available: true,
      missing: [],
    });
    assert.deepEqual(sandboxDependencies({ platform: 'linux', which: whichOf(['bwrap']) }), {
      available: false,
      missing: ['socat'],
    });
    assert.deepEqual(sandboxDependencies({ platform: 'linux', which: whichOf([]) }), {
      available: false,
      missing: ['bwrap', 'socat'],
    });
  });

  it('darwin needs sandbox-exec', () => {
    assert.deepEqual(sandboxDependencies({ platform: 'darwin', which: whichOf(['sandbox-exec']) }), {
      available: true,
      missing: [],
    });
    assert.deepEqual(sandboxDependencies({ platform: 'darwin', which: whichOf([]) }), {
      available: false,
      missing: ['sandbox-exec'],
    });
  });

  it('win32 is unsupported', () => {
    assert.deepEqual(sandboxDependencies({ platform: 'win32', which: whichOf(['bwrap', 'socat']) }), {
      available: false,
      missing: ['unsupported platform: win32'],
    });
  });
});

describe('argument validation', () => {
  for (const field of ['worktreeDir', 'projectRoot', 'homeDir', 'tmpDir']) {
    it(`throws a TypeError naming ${field} when missing`, () => {
      const args = { ...BASE, agentType: 'dev-lead', deps: OK_DEPS };
      delete args[field];
      assert.throws(() => buildJobSandboxSettings(args), (e) => e instanceof TypeError && e.message.includes(field));
    });
    it(`throws a TypeError naming ${field} when relative`, () => {
      const args = { ...BASE, agentType: 'dev-lead', deps: OK_DEPS, [field]: 'rel/dir' };
      assert.throws(() => buildJobSandboxSettings(args), (e) => e instanceof TypeError && e.message.includes(field));
    });
  }
});

describe('sandboxChildEnv', () => {
  it('points TMPDIR, TMP and TEMP at the private dir for os-sandbox', () => {
    const p = buildJobSandboxSettings({ ...BASE, agentType: 'dev-lead', environment: envFor('dev-lead'), deps: OK_DEPS });
    assert.equal(p.level, 'os-sandbox');
    assert.deepEqual(sandboxChildEnv(p, '/tmp/smj-abc123'), {
      TMPDIR: '/tmp/smj-abc123',
      TMP: '/tmp/smj-abc123',
      TEMP: '/tmp/smj-abc123',
    });
  });

  it('returns {} for tool-rules', () => {
    const p = buildJobSandboxSettings({ ...BASE, agentType: 'dev-lead', environment: envFor('dev-lead'), deps: { available: false, missing: ['socat'] }, mode: 'report' });
    assert.equal(p.level, 'tool-rules');
    assert.deepEqual(sandboxChildEnv(p, '/tmp/smj-abc123'), {});
    assert.deepEqual(sandboxChildEnv(null, '/tmp/smj-abc123'), {});
  });
});
