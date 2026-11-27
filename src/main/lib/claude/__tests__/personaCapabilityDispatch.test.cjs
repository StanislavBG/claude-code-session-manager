/**
 * personaCapabilityDispatch.test.cjs — a scheduler dispatch passes exactly
 * the persona's declared + tool-named MCP servers under --strict-mcp-config,
 * records the resolved set in the AgentSnapshot, and refuses (never spawns,
 * never widens) a job whose set names an unknown server or pack — the refusal
 * the dispatch loop parks as needs_review 'capability_unknown: <name>'.
 *
 * Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/personaCapabilityDispatch.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let scheduler;
let agentSnapshot;
let SERVER_NAME;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-capability-dispatch-'));
  process.env.HOME = tmpHome;
  scheduler = require('../../../scheduler.cjs');
  agentSnapshot = require('../agentSnapshot.cjs');
  ({ SERVER_NAME } = require('../../../seedSchedulerMcp.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

function writePersona(cwd, name, lines) {
  const dir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), ['---', `name: ${name}`, 'model: sonnet', ...lines, '---', 'body'].join('\n'));
}

function setupProject() {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-cap-main-'));
  const slug = `3790-cap-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'argv.marker'), JSON.stringify(process.argv.slice(2)), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
  return { mainCwd, slug };
}

async function dispatch(job, mainCwd) {
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-cap-run-'));
  const marker = path.join(mainCwd, 'argv.marker');
  fs.rmSync(marker, { force: true });
  const result = await scheduler.executeJob(job, runDir, mainCwd, () => Promise.resolve(), undefined, null);
  const argv = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${job.slug}.meta.json`), 'utf8'));
  fs.rmSync(runDir, { recursive: true, force: true });
  return { result, argv, meta };
}

test('declared known server: strict argv with exactly that server; snapshot records it', async () => {
  const { mainCwd, slug } = setupProject();
  try {
    writePersona(mainCwd, 'cap-ok', ['tools: Read', `mcpServers: ${SERVER_NAME}`]);
    const job = { slug, cwd: mainCwd, agentType: 'cap-ok' };
    const { result, argv } = await dispatch(job, mainCwd);
    expect(result.exitCode).toBe(0);
    const i = argv.indexOf('--mcp-config');
    expect(Object.keys(JSON.parse(argv[i + 1]).mcpServers)).toEqual([SERVER_NAME]);
    expect(argv[i + 2]).toBe('--strict-mcp-config');
    const snap = await agentSnapshot.readAgentSnapshot(mainCwd, job.agentSnapshotId);
    expect(snap.mcpServers).toEqual([SERVER_NAME]);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
});

test('unscoped persona with nothing declared still runs strict', async () => {
  const { mainCwd, slug } = setupProject();
  try {
    writePersona(mainCwd, 'cap-open', []);
    const { result, argv } = await dispatch({ slug, cwd: mainCwd, agentType: 'cap-open' }, mainCwd);
    expect(result.exitCode).toBe(0);
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--mcp-config');
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
});

for (const [label, lines, name] of [
  ['tool-named unknown server', ['tools: Read, mcp__ghost__do'], 'ghost'],
  ['declared unknown server', ['tools: Read', 'mcpServers: nope'], 'nope'],
  ['declared unknown pack', ['tools: Read', 'packs: no-such-pack'], 'no-such-pack'],
]) {
  test(`${label}: refused capability_unknown naming it, never spawned`, async () => {
    const { mainCwd, slug } = setupProject();
    try {
      writePersona(mainCwd, 'cap-bad', lines);
      const { result, argv, meta } = await dispatch({ slug, cwd: mainCwd, agentType: 'cap-bad' }, mainCwd);
      expect(argv).toBeNull();
      expect(result.exitCode).toBe(-1);
      const detail = label.includes('pack') ? name : `${name} (MCP server not defined in ~/.claude.json, <project>/.mcp.json or the project's local scope)`;
      expect(result.personaRefusal).toEqual({ code: 'capability_unknown', detail });
      expect(result.error).toBe(`capability_unknown: ${detail}`);
      expect(meta.personaRefusal.code).toBe('capability_unknown');
    } finally {
      fs.rmSync(mainCwd, { recursive: true, force: true });
    }
  });
}

test('applyPersonaRefusalPark parks the row with reason capability_unknown: <name>', () => {
  const park = scheduler.applyPersonaRefusalPark;
  const row = { slug: 'x', status: 'running' };
  expect(park(row, { code: 'capability_unknown', detail: 'ghost' })).toBe(true);
  expect(row.status).toBe('needs_review');
  expect(row.error).toBe('capability_unknown: ghost');
});
