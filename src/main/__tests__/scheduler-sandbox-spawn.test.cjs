/**
 * scheduler-sandbox-spawn.test.cjs — PRD job-sandbox-spawn-wiring: a PRD job
 * launches with buildJobSandboxSettings' argv in place of the unconditional
 * --dangerously-skip-permissions; no sandboxArgs = today's argv.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-sandbox-spawn.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let buildClaudeSpawnArgs;
let buildJobSandboxSettings;

const BASE = { model: 'opus', effort: null, sessionId: 'sess-1', resume: false, systemPrompt: 'You are dev-lead.', toolScope: null };

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sandbox-spawn-'));
  process.env.HOME = tmpHome;
  ({ buildClaudeSpawnArgs } = require('../scheduler.cjs'));
  ({ buildJobSandboxSettings } = require('../lib/claude/jobSandboxPolicy.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function policy(agentType, deps = { available: true, missing: [] }) {
  return buildJobSandboxSettings({
    agentType,
    worktreeDir: path.join(tmpHome, 'wt'),
    projectRoot: path.join(tmpHome, 'proj'),
    homeDir: tmpHome,
    tmpDir: os.tmpdir(),
    deps,
  });
}

test('os-sandbox argv drops the bypass flag and carries parseable --settings', () => {
  const p = policy('dev-lead');
  expect(p.level).toBe('os-sandbox');
  const args = buildClaudeSpawnArgs({ ...BASE, sandboxArgs: p.argv });
  expect(args).not.toContain('--dangerously-skip-permissions');
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  expect(settings.sandbox.enabled).toBe(true);
  const dis = args.indexOf('--disallowedTools');
  expect(dis).toBeGreaterThan(args.indexOf('--settings'));
  expect(args[dis + 2]).toBe('--output-format');
});

test('sandboxArgs replace the bypass flag at the same position', () => {
  const plain = buildClaudeSpawnArgs({ ...BASE, pluginDirArgs: ['--plugin-dir', '/a'] });
  const p = policy('validator');
  const sandboxed = buildClaudeSpawnArgs({ ...BASE, pluginDirArgs: ['--plugin-dir', '/a'], sandboxArgs: p.argv });
  const at = plain.indexOf('--dangerously-skip-permissions');
  expect(sandboxed.slice(0, at)).toEqual(plain.slice(0, at));
  expect(sandboxed.slice(at, at + p.argv.length)).toEqual(p.argv);
  expect(sandboxed.slice(at + p.argv.length)).toEqual(plain.slice(at + 1));
});

test('tool-rules argv keeps the bypass flag and adds deny settings', () => {
  const p = policy('dev-lead', { available: false, missing: ['socat'] });
  expect(p.level).toBe('tool-rules');
  const args = buildClaudeSpawnArgs({ ...BASE, sandboxArgs: p.argv });
  expect(args).toContain('--dangerously-skip-permissions');
  expect(JSON.parse(args[args.indexOf('--settings') + 1]).permissions.deny.length).toBeGreaterThan(0);
});

test('without sandboxArgs (null or empty) the argv is unchanged', () => {
  const plain = buildClaudeSpawnArgs(BASE);
  expect(buildClaudeSpawnArgs({ ...BASE, sandboxArgs: null })).toEqual(plain);
  expect(buildClaudeSpawnArgs({ ...BASE, sandboxArgs: [] })).toEqual(plain);
  expect(plain.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1);
  expect(plain).not.toContain('--settings');
});
