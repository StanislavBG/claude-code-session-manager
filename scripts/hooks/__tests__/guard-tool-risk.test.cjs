/**
 * guard-tool-risk.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-tool-risk.cjs.
 *
 * Calls `decide(payload, env, deps)` from
 * scripts/hooks/lib/guard-tool-risk-policy.cjs in-process with explicit env
 * objects (never the ambient process.env — this suite may itself run inside
 * a scheduler job) and a temp homeDir / SM_PROJECT_ROOT holding
 * tool-risk.json fixtures. One smoke test spawns the real CLI.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-tool-risk.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decide, parsePayload } = require('../lib/guard-tool-risk-policy.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'guard-tool-risk.cjs');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Write a raw string or object as <dir>/.claude/tool-risk.json; returns the file path. */
function writeMarks(dir, content) {
  const file = path.join(dir, '.claude', 'tool-risk.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function fixture({ system, project } = {}) {
  const homeDir = mkTmp('tool-risk-home-');
  const projectRoot = mkTmp('tool-risk-proj-');
  const systemFile = system !== undefined ? writeMarks(homeDir, system) : path.join(homeDir, '.claude', 'tool-risk.json');
  const projectFile = project !== undefined ? writeMarks(projectRoot, project) : path.join(projectRoot, '.claude', 'tool-risk.json');
  return { homeDir, projectRoot, systemFile, projectFile };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const mcp = (name) => ({ tool_name: name, tool_input: {} });
const decisionOf = (r) => (r.hookSpecificOutput ? r.hookSpecificOutput.permissionDecision : 'allow');
const reasonOf = (r) => r.hookSpecificOutput.permissionDecisionReason;

const SYSTEM_MARKS = {
  version: 1,
  marks: {
    'Bash(npm publish:*)': 'public',
    'Bash(git push --force)': 'irreversible',
    'mcp__stripe__*': 'money',
    'mcp__bilko-host__publish_static_project': 'public',
    'Bash(git status)': 'read',
  },
};

function headlessEnv(f, extra = {}) {
  return { SM_SCHEDULER_JOB_SLUG: '123-test-job', SM_PROJECT_ROOT: f.projectRoot, ...extra };
}

// ── headless ────────────────────────────────────────────────────────────────

test('headless: denies a System-marked public Bash command with a reason naming mark, rule, layer and file', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const r = decide(bash('npm publish --tag latest'), headlessEnv(f), { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
  const reason = reasonOf(r);
  expect(reason).toContain('npm publish --tag latest');
  expect(reason).toContain('public');
  expect(reason).toContain('Bash(npm publish:*)');
  expect(reason).toContain('System');
  expect(reason).toContain(f.systemFile);
  expect(reason).toContain('name it in riskTools');
  expect(reason).toContain('Do not work around this refusal');
});

test('headless via SM_TOOL_RISK_HEADLESS=1: denies a money MCP call through a server wildcard', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const r = decide(mcp('mcp__stripe__create_charge'), { SM_TOOL_RISK_HEADLESS: '1', SM_PROJECT_ROOT: f.projectRoot }, { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain('mcp__stripe__create_charge');
  expect(reasonOf(r)).toContain('money');
  expect(reasonOf(r)).toContain('mcp__stripe__*');
});

test('headless: a PRD clearance entry (SM_SCHEDULER_JOB_RISK_TOOLS) that matches the call allows it', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const env = headlessEnv(f, { SM_SCHEDULER_JOB_RISK_TOOLS: JSON.stringify(['Bash(npm publish:*)', 'mcp__bilko-host__publish_static_project']) });
  expect(decisionOf(decide(bash('npm publish --tag latest'), env, { homeDir: f.homeDir }))).toBe('allow');
  expect(decisionOf(decide(mcp('mcp__bilko-host__publish_static_project'), env, { homeDir: f.homeDir }))).toBe('allow');
  // A clearance for one rule does not clear another.
  expect(decisionOf(decide(bash('git push --force'), env, { homeDir: f.homeDir }))).toBe('deny');
});

test('headless: a clearance that does not match the call does not allow it', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const env = headlessEnv(f, { SM_SCHEDULER_JOB_RISK_TOOLS: JSON.stringify(['mcp__stripe__refund']) });
  expect(decisionOf(decide(mcp('mcp__stripe__create_charge'), env, { homeDir: f.homeDir }))).toBe('deny');
});

test('headless: Project marks override System (System public -> Project write is allowed)', () => {
  const f = fixture({
    system: SYSTEM_MARKS,
    project: { version: 1, marks: { 'Bash(npm publish:*)': 'write' } },
  });
  expect(decisionOf(decide(bash('npm publish'), headlessEnv(f), { homeDir: f.homeDir }))).toBe('allow');
});

test('headless: a Project-layer block names Project and the project file', () => {
  const f = fixture({ project: { version: 1, marks: { 'Bash(make deploy)': 'public' } } });
  const r = decide(bash('make deploy'), headlessEnv(f), { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain('Project');
  expect(reasonOf(r)).toContain(f.projectFile);
});

test('headless: the Project layer is read from SM_PROJECT_ROOT, never payload.cwd', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const worktree = mkTmp('tool-risk-wt-');
  writeMarks(worktree, { version: 1, marks: { 'Bash(npm publish:*)': 'write' } });
  const r = decide({ ...bash('npm publish'), cwd: worktree }, headlessEnv(f), { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
});

test('headless: unmarked and non-blocking calls are allowed', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const env = headlessEnv(f);
  expect(decisionOf(decide(bash('ls -la'), env, { homeDir: f.homeDir }))).toBe('allow');
  expect(decisionOf(decide(bash('git status'), env, { homeDir: f.homeDir }))).toBe('allow');
  expect(decisionOf(decide(mcp('mcp__other__thing'), env, { homeDir: f.homeDir }))).toBe('allow');
  expect(decisionOf(decide({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }, env, { homeDir: f.homeDir }))).toBe('allow');
});

test('headless: with no marks files at all, everything is allowed', () => {
  const f = fixture();
  expect(decisionOf(decide(bash('npm publish'), headlessEnv(f), { homeDir: f.homeDir }))).toBe('allow');
});

test('headless: a compound Bash command is denied when any simple command blocks', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const r = decide(bash('git status && npm run build && npm publish'), headlessEnv(f), { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain('Bash(npm publish:*)');
});

test('headless: a compound Bash command clearing one blocking command still denies the other', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const env = headlessEnv(f, { SM_SCHEDULER_JOB_RISK_TOOLS: JSON.stringify(['Bash(npm publish:*)']) });
  const r = decide(bash('npm publish && git push --force'), env, { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain('Bash(git push --force)');
  // ...and clearing both allows it.
  const env2 = headlessEnv(f, { SM_SCHEDULER_JOB_RISK_TOOLS: JSON.stringify(['Bash(npm publish:*)', 'Bash(git push:*)']) });
  expect(decisionOf(decide(bash('npm publish && git push --force'), env2, { homeDir: f.homeDir }))).toBe('allow');
});

test('headless: an unreadable marks file fails closed for Bash and MCP, naming the file and error', () => {
  const f = fixture({ system: '{ not json' });
  const env = headlessEnv(f);
  for (const payload of [bash('ls'), mcp('mcp__other__thing')]) {
    const r = decide(payload, env, { homeDir: f.homeDir });
    expect(decisionOf(r)).toBe('deny');
    expect(reasonOf(r)).toContain(f.systemFile);
    expect(reasonOf(r)).toContain('not valid JSON');
  }
  // Non-Bash/MCP tools are not affected.
  expect(decisionOf(decide({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }, env, { homeDir: f.homeDir }))).toBe('allow');
});

test('headless: an invalid Project marks file fails closed too', () => {
  const f = fixture({ project: { version: 2, marks: {} } });
  const r = decide(bash('ls'), headlessEnv(f), { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain(f.projectFile);
  expect(reasonOf(r)).toContain('"version" must be 1');
});

test('headless: Write/Edit/NotebookEdit of any marks file is denied', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const worktree = mkTmp('tool-risk-wt-');
  const env = headlessEnv(f);
  const targets = [
    { tool_name: 'Write', tool_input: { file_path: f.systemFile, content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: f.projectFile, old_string: 'a', new_string: 'b' } },
    { tool_name: 'Write', tool_input: { file_path: '.claude/tool-risk.json', content: '{}' }, cwd: worktree },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(worktree, '.claude', 'tool-risk.json') }, cwd: worktree },
  ];
  for (const payload of targets) {
    const r = decide(payload, env, { homeDir: f.homeDir });
    expect(decisionOf(r)).toBe('deny');
    expect(reasonOf(r)).toContain('marks are human-owned: edit them in Settings');
  }
  // An ordinary Write is untouched.
  const ok = decide({ tool_name: 'Write', tool_input: { file_path: path.join(worktree, 'src', 'a.js'), content: '' }, cwd: worktree }, env, { homeDir: f.homeDir });
  expect(decisionOf(ok)).toBe('allow');
});

// ── interactive ─────────────────────────────────────────────────────────────

test('interactive (default): blocking marks are allowed', () => {
  const f = fixture({ system: SYSTEM_MARKS, project: { version: 1, marks: { 'Bash(make deploy)': 'public' } } });
  const env = { SM_PROJECT_ROOT: f.projectRoot };
  expect(decisionOf(decide(bash('npm publish'), env, { homeDir: f.homeDir }))).toBe('allow');
  expect(decisionOf(decide(bash('make deploy'), env, { homeDir: f.homeDir }))).toBe('allow');
  expect(decisionOf(decide({ tool_name: 'Write', tool_input: { file_path: f.systemFile, content: '' } }, env, { homeDir: f.homeDir }))).toBe('allow');
});

test('interactive (default): an unreadable marks file does not block', () => {
  const f = fixture({ system: '{ nope' });
  expect(decisionOf(decide(bash('ls'), { SM_PROJECT_ROOT: f.projectRoot }, { homeDir: f.homeDir }))).toBe('allow');
});

test('interactive opt-in: a Chat turn (SM_CHAT_SESSION_ID) is denied', () => {
  const f = fixture({ system: SYSTEM_MARKS, project: { version: 1, interactive: true, marks: {} } });
  const r = decide(bash('npm publish'), { SM_PROJECT_ROOT: f.projectRoot, SM_CHAT_SESSION_ID: 'abc' }, { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain('Bash(npm publish:*)');
  expect(reasonOf(r)).toContain('System');
});

test('interactive opt-in: a Terminal session gets ask with the same reason', () => {
  const f = fixture({ system: SYSTEM_MARKS, project: { version: 1, interactive: true, marks: {} } });
  const r = decide(bash('npm publish'), { SM_PROJECT_ROOT: f.projectRoot }, { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('ask');
  expect(reasonOf(r)).toContain('public');
  expect(reasonOf(r)).toContain(f.systemFile);
  // Unmarked calls still pass.
  expect(decisionOf(decide(bash('ls'), { SM_PROJECT_ROOT: f.projectRoot }, { homeDir: f.homeDir }))).toBe('allow');
});

// ── parsing / fail-open ─────────────────────────────────────────────────────

test('parsePayload fails open on malformed JSON', () => {
  expect(parsePayload('{ nope')).toEqual({});
  expect(parsePayload('')).toEqual({});
  expect(parsePayload('{"tool_name":"Bash"}')).toEqual({ tool_name: 'Bash' });
});

test('malformed clearance JSON is treated as no clearance (still denies)', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const r = decide(bash('npm publish'), headlessEnv(f, { SM_SCHEDULER_JOB_RISK_TOOLS: 'not json' }), { homeDir: f.homeDir });
  expect(decisionOf(r)).toBe('deny');
});

test('an internal error fails open', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const r = decide(null, headlessEnv(f), { homeDir: f.homeDir });
  expect(r).toEqual({ continue: true });
});

// ── smoke: real process wiring ──────────────────────────────────────────────

test('smoke: real process wiring denies a marked command (stdin JSON in, stdout JSON out)', () => {
  const f = fixture({ system: SYSTEM_MARKS });
  const { SM_SCHEDULER_JOB_SLUG: _a, SM_SCHEDULER_JOB_RISK_TOOLS: _b, SM_CHAT_SESSION_ID: _c, ...cleanEnv } = process.env;
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(bash('npm publish')),
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...cleanEnv, HOME: f.homeDir, SM_TOOL_RISK_HEADLESS: '1', SM_PROJECT_ROOT: f.projectRoot },
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Bash(npm publish:*)');
});
