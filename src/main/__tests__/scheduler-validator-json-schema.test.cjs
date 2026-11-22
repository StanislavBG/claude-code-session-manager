/**
 * scheduler-validator-json-schema.test.cjs — PRD 3613: every validator job
 * (fresh and resumed) spawns with `--json-schema <VALIDATOR_VERDICT_SCHEMA>`
 * and StructuredOutput in its enforced tool scope (probe 2026-11-22, CLI
 * 2.1.325: a scoped run without StructuredOutput silently ignores the schema).
 * Every other job's argv is unchanged.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-validator-json-schema.test.cjs
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
let buildClaudeSpawnArgs;
let VALIDATOR_VERDICT_SCHEMA;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validator-schema-'));
  process.env.HOME = tmpHome;
  ({ executeJob, buildClaudeSpawnArgs } = require('../scheduler.cjs'));
  ({ VALIDATOR_VERDICT_SCHEMA } = require('../lib/scheduler/validatorVerdictSchema.cjs'));
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'dev-lead.md'), '---\nname: dev-lead\nmodel: opus\ntools: Read, Bash\n---\nYou are dev-lead.');
  fs.writeFileSync(path.join(agentsDir, 'validator.md'), '---\nname: validator\nmodel: opus\ntools: Read, Grep, Glob, Bash\n---\nYou are validator.');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'argv.marker'), JSON.stringify(process.argv.slice(2)), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

async function runJob({ agentType, resumeTarget = null }) {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-vschema-main-'));
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-vschema-run-'));
  const slug = `3613-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  process.env.SM_CLAUDE_BIN = writeClaudeStub();
  const job = { slug, cwd: mainCwd, agentType };
  try {
    const result = await executeJob(job, runDir, mainCwd, () => Promise.resolve(), undefined, resumeTarget);
    const argv = JSON.parse(fs.readFileSync(path.join(mainCwd, 'argv.marker'), 'utf8'));
    return { result, argv };
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function scopedTools(argv) {
  const i = argv.indexOf('--agents');
  if (i < 0) return null;
  const parsed = JSON.parse(argv[i + 1]);
  return Object.values(parsed)[0].tools;
}

function expectSchemaPlacement(argv) {
  const schemaJson = JSON.stringify(VALIDATOR_VERDICT_SCHEMA);
  expect(argv.filter((a) => a === '--json-schema')).toHaveLength(1);
  const at = argv.indexOf('--json-schema');
  expect(argv[at + 1]).toBe(schemaJson);
  expect(at).toBeLessThan(argv.indexOf('--dangerously-skip-permissions'));
  const dis = argv.indexOf('--disallowedTools');
  expect(at).not.toBe(dis + 1);
}

// ---------- buildClaudeSpawnArgs ----------

test('buildClaudeSpawnArgs: jsonSchema adds --json-schema <json> once, before --dangerously-skip-permissions', () => {
  for (const resume of [true, false]) {
    const args = buildClaudeSpawnArgs({ model: 'opus', sessionId: 's', resume, jsonSchema: VALIDATOR_VERDICT_SCHEMA, toolScope: { tools: ['Read'] } });
    expectSchemaPlacement(args);
  }
});

test('buildClaudeSpawnArgs: null/absent jsonSchema equals today\'s argv element for element', () => {
  for (const resume of [true, false]) {
    const base = { model: 'opus', sessionId: 's', resume, toolScope: { tools: ['Read'] } };
    const today = buildClaudeSpawnArgs(base);
    expect(today).not.toContain('--json-schema');
    expect(buildClaudeSpawnArgs({ ...base, jsonSchema: null })).toEqual(today);
    expect(buildClaudeSpawnArgs({ ...base, jsonSchema: undefined })).toEqual(today);
  }
});

// ---------- executeJob ----------

test('executeJob: a validator job spawns with --json-schema and StructuredOutput in scope', async () => {
  const { result, argv } = await runJob({ agentType: 'validator' });
  expect(result.exitCode).toBe(0);
  expect(argv).toContain('--session-id');
  expectSchemaPlacement(argv);
  expect(scopedTools(argv)).toContain('StructuredOutput');
});

test('executeJob: a resumed validator job keeps --json-schema and StructuredOutput', async () => {
  const { argv } = await runJob({ agentType: 'validator', resumeTarget: { sessionId: 'resume-sid-3613', dirtyPaths: [] } });
  expect(argv).toContain('--resume');
  expect(argv[argv.indexOf('--resume') + 1]).toBe('resume-sid-3613');
  expectSchemaPlacement(argv);
  expect(scopedTools(argv)).toContain('StructuredOutput');
});

test('executeJob: a dev-lead job (fresh and resumed) has no --json-schema and no StructuredOutput', async () => {
  for (const resumeTarget of [null, { sessionId: 'resume-sid-dl', dirtyPaths: [] }]) {
    const { result, argv } = await runJob({ agentType: 'dev-lead', resumeTarget });
    expect(result.exitCode).toBe(0);
    expect(argv).not.toContain('--json-schema');
    expect(scopedTools(argv)).not.toContain('StructuredOutput');
  }
});
