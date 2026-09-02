/**
 * scheduler-prd-persona-spawn.test.cjs — PRD 1115: a PRD's `agentType`
 * frontmatter must actually drive the headless spawn (--append-system-prompt
 * with the persona's frontmatter-stripped, capped body, and --model with the
 * persona's own model), not just sit in the prompt as prose the executor may
 * or may not obey. Covers buildClaudeSpawnArgs' pure argv shape plus a real
 * executeJob spawn (stub `claude` binary) proving the resolved persona
 * actually reaches the child process, and that a dangling agentType still
 * runs the job to completion (never parks or fails it).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-prd-persona-spawn.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let executeJob;
let buildClaudeSpawnArgs;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-persona-spawn-'));
  process.env.HOME = tmpHome;
  ({ executeJob, buildClaudeSpawnArgs } = require('../scheduler.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

// ---------- buildClaudeSpawnArgs: systemPrompt -> --append-system-prompt ----------

test('buildClaudeSpawnArgs: a given systemPrompt is passed via --append-system-prompt', () => {
  const args = buildClaudeSpawnArgs({ prompt: 'prd body', model: 'opus', sessionId: 'sid', resume: false, systemPrompt: 'You are dev-lead.' });
  const idx = args.indexOf('--append-system-prompt');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).toBe('You are dev-lead.');
});

test('buildClaudeSpawnArgs: omits --append-system-prompt entirely when systemPrompt is absent', () => {
  const args = buildClaudeSpawnArgs({ prompt: 'prd body', model: 'sonnet', sessionId: 'sid', resume: false });
  expect(args).not.toContain('--append-system-prompt');
});

test('buildClaudeSpawnArgs: model is never omitted even without a systemPrompt', () => {
  const args = buildClaudeSpawnArgs({ prompt: 'x', model: 'sonnet', sessionId: 'sid', resume: false });
  const idx = args.indexOf('--model');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).toBe('sonnet');
});

// ---------- real spawn: persona actually reaches the child process ----------

// Stub `claude` binary: dumps its own argv into a marker file, then emits a
// stream-json success result and exits 0 — same technique as
// scheduler-bash-timeout-env.test.cjs's env-var proof, applied to argv.
function writeClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-argv-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'argv.marker'), JSON.stringify(process.argv.slice(2)), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

function writePersona(dir, name, frontmatterLines, bodyText) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, ...frontmatterLines, '---', bodyText];
  fs.writeFileSync(path.join(dir, `${name}.md`), lines.join('\n'));
}

async function runJobWithAgentType({ agentType }) {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-persona-main-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-prd-persona-run-'));
  const slug = `1115-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  const job = { slug, cwd: mainCwd, agentType };
  const result = await executeJob(job, runDir, mainCwd, () => Promise.resolve());
  const argv = JSON.parse(fs.readFileSync(path.join(mainCwd, 'argv.marker'), 'utf8'));
  fs.rmSync(mainCwd, { recursive: true, force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
  return { result, argv };
}

test('executeJob: a resolvable agentType reaches the spawned child as --append-system-prompt + --model', async () => {
  const globalAgentsDir = path.join(tmpHome, '.claude', 'agents');
  writePersona(globalAgentsDir, 'dev-lead', ['model: opus'], 'You are dev-lead. Ship it.');

  const { result, argv } = await runJobWithAgentType({ agentType: 'dev-lead' });

  expect(result.exitCode).toBe(0);
  const spIdx = argv.indexOf('--append-system-prompt');
  expect(spIdx).toBeGreaterThanOrEqual(0);
  expect(argv[spIdx + 1]).toBe('You are dev-lead. Ship it.');
  const modelIdx = argv.indexOf('--model');
  expect(argv[modelIdx + 1]).toBe('opus');
});

test('executeJob: a dangling agentType (no resolvable persona file) still runs the job to completion, falling back to sonnet with no --append-system-prompt', async () => {
  const { result, argv } = await runJobWithAgentType({ agentType: 'renamed-or-deleted-persona' });

  expect(result.exitCode).toBe(0);
  expect(argv).not.toContain('--append-system-prompt');
  const modelIdx = argv.indexOf('--model');
  expect(argv[modelIdx + 1]).toBe('sonnet');
});

test('executeJob: a job with no agentType at all runs unaffected (no persona, sonnet fallback)', async () => {
  const { result, argv } = await runJobWithAgentType({ agentType: null });

  expect(result.exitCode).toBe(0);
  expect(argv).not.toContain('--append-system-prompt');
  const modelIdx = argv.indexOf('--model');
  expect(argv[modelIdx + 1]).toBe('sonnet');
});
