/**
 * scheduler-job-mcp-scope-env.test.cjs — a scoped persona's job child carries
 * SM_SCHEDULER_JOB_MCP_TOOLS; an unscoped persona's carries nothing.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-job-mcp-scope-env.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let executeJob;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mcp-scope-env-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  ({ executeJob } = require('../scheduler.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

function writeStub() {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    const v = process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
    fs.writeFileSync(path.join(process.cwd(), 'mcp-tools.marker'), v === undefined ? 'UNSET' : v, 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, usage: { input_tokens: 10, output_tokens: 20 }, result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

function writePersona(name, toolsLine) {
  fs.writeFileSync(
    path.join(tmpHome, '.claude', 'agents', `${name}.md`),
    `---\nname: ${name}\ndescription: test persona\n${toolsLine}---\n\nBody.\n`,
    'utf8',
  );
}

async function runJob(agentType) {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mcp-scope-main-'));
  const slug = `1301-mcp-scope-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-mcp-scope-run-'));
  process.env.SM_CLAUDE_BIN = writeStub();
  try {
    await executeJob({ slug, cwd: mainCwd, agentType }, runDir, mainCwd, () => Promise.resolve());
    return fs.readFileSync(path.join(mainCwd, 'mcp-tools.marker'), 'utf8');
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
}

test('scoped persona with no mcp__ tool: child env carries SM_SCHEDULER_JOB_MCP_TOOLS=[]', async () => {
  writePersona('mcp-scope-scoped', 'tools: Read, Bash\n');
  expect(await runJob('mcp-scope-scoped')).toBe('[]');
});

test('unscoped persona (no tools line): child env has SM_SCHEDULER_JOB_MCP_TOOLS unset', async () => {
  writePersona('mcp-scope-unscoped', '');
  expect(await runJob('mcp-scope-unscoped')).toBe('UNSET');
});
