/**
 * scheduler.spawnArgs.test.cjs — PRD scheduler-tool-risk-wiring: a job's argv
 * loads guard-tool-risk via --settings <file>, and its clearance list is
 * stamped from PRD riskTools + persona tools.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler.spawnArgs.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let sched;
let buildJobSandboxSettings;
let legacyEnvironment;

/** The environment profile the scheduler resolves for a persona with no `environment:` frontmatter. */
function makeLegacyEnvironment() {
  const { jobEnvironmentName } = require('../lib/claude/jobSandboxPolicy.cjs');
  const { BUILTIN_ENVIRONMENTS } = require('../lib/claude/environmentProfiles.cjs');
  return {
    legacyEnvironment(agentType) {
      const id = jobEnvironmentName({ agentType });
      return id ? { id, profile: BUILTIN_ENVIRONMENTS[id] } : null;
    },
  };
}
let writeToolRiskGuardSettingsFile;

const BASE = { model: 'opus', effort: null, sessionId: 'sess-1', resume: false, systemPrompt: 'You are dev-lead.', toolScope: null };

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-spawnargs-'));
  process.env.HOME = tmpHome;
  sched = require('../scheduler.cjs');
  ({ buildJobSandboxSettings } = require('../lib/claude/jobSandboxPolicy.cjs'));
  ({ legacyEnvironment } = makeLegacyEnvironment());
  ({ writeToolRiskGuardSettingsFile } = require('../lib/epic/guardSpawnSettings.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function policy(agentType, deps) {
  return buildJobSandboxSettings({
    agentType,
    environment: legacyEnvironment(agentType),
    worktreeDir: path.join(tmpHome, 'wt'),
    projectRoot: path.join(tmpHome, 'proj'),
    homeDir: tmpHome,
    tmpDir: os.tmpdir(),
    deps,
    // These tests pin the report-mode argv (missing deps → tool rules); enforce refuses instead.
    mode: 'report',
  });
}

test('no sandboxArgs: --settings <path> sits right before --dangerously-skip-permissions', () => {
  const p = '/tmp/x/tool-risk-abc.json';
  const args = sched.buildClaudeSpawnArgs({ ...BASE, riskGuardSettingsPath: p });
  const i = args.indexOf('--settings');
  expect(args[i + 1]).toBe(p);
  expect(args[i + 2]).toBe('--dangerously-skip-permissions');
  const dis = args.indexOf('--disallowedTools');
  expect(i).toBeLessThan(dis);
  expect(args[dis + 2]).toBe('--output-format');
  expect(args.filter((a) => a === '--settings')).toHaveLength(1);
});

test('resume spawn carries --settings too', () => {
  const args = sched.buildClaudeSpawnArgs({ ...BASE, resume: true, riskGuardSettingsPath: '/tmp/r.json' });
  expect(args[args.indexOf('--settings') + 1]).toBe('/tmp/r.json');
  expect(args).toContain('--resume');
});

test('null/absent path: argv unchanged from today', () => {
  const a = sched.buildClaudeSpawnArgs({ ...BASE });
  const b = sched.buildClaudeSpawnArgs({ ...BASE, riskGuardSettingsPath: null });
  expect(b).toEqual(a);
  expect(a).not.toContain('--settings');
});

test('sandbox argv with inline --settings: guard hooks merged into that one --settings (CLI keeps only the last)', async () => {
  const file = await writeToolRiskGuardSettingsFile({ homeDir: tmpHome });
  expect(file).toBeTruthy();
  for (const p of [policy('dev-lead', { available: true, missing: [] }), policy('dev-lead', { available: false, missing: ['bwrap'] })]) {
    const args = sched.buildClaudeSpawnArgs({ ...BASE, sandboxArgs: p.argv, riskGuardSettingsPath: file });
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.permissions).toEqual(p.settings.permissions);
    expect(settings.sandbox).toEqual(p.settings.sandbox);
    const cmds = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds.some((c) => c.includes('guard-tool-risk.cjs'))).toBe(true);
    const dis = args.indexOf('--disallowedTools');
    expect(args.indexOf('--settings')).toBeLessThan(dis);
    expect(args[dis + 2]).toBe('--output-format');
  }
});

test('jobRiskToolsClearance: PRD riskTools + persona MCP/Bash(...) tools, parseRule-valid only, deduped', () => {
  const out = sched.jobRiskToolsClearance(
    ['Bash(npm publish:*)', 'not a rule', 'mcp__stripe__refund'],
    ['Read', 'Bash', 'mcp__bilko-host__publish_static_project', 'Bash(npm publish:*)', 'Edit'],
  );
  expect(out).toEqual(['Bash(npm publish:*)', 'mcp__stripe__refund', 'mcp__bilko-host__publish_static_project']);
  expect(sched.jobRiskToolsClearance(undefined, null)).toEqual([]);
  expect(JSON.stringify(sched.jobRiskToolsClearance([], []))).toBe('[]');
});

test('buildClaudeSpawnArgs appends skill deny args for a persona without the carrying pack, omits them with it', async () => {
  const { resolveSkillDeny } = require('../lib/claude/personaToolScope.cjs');
  const deps = {
    listPacks: () => ({ packs: [{ id: 'dev', skills: ['session-manager-dev:develop'] }] }),
    listUnpackedSkills: () => [],
    getBuiltinTools: async () => ({ tools: [], skills: [] }),
  };
  const deny = '--disallowedTools=Skill(session-manager-dev:develop)';
  const without = await resolveSkillDeny({ packs: [], loadout: 'equipped', deps });
  const withPack = await resolveSkillDeny({ packs: ['dev'], loadout: 'equipped', deps });
  expect(sched.buildClaudeSpawnArgs({ ...BASE, skillDeny: without.args })).toContain(deny);
  expect(sched.buildClaudeSpawnArgs({ ...BASE, skillDeny: withPack.args })).not.toContain(deny);
  expect(sched.buildClaudeSpawnArgs({ ...BASE }).some((a) => a.includes('Skill('))).toBe(false);
});
