/**
 * headlessMcpDispatch.test.cjs — a persona's declared MCP servers resolve through
 * resolveHeadlessMcpServers at dispatch: a user-scope server reaches --mcp-config,
 * a credentialed one is refused capability_credentialed, an undefined one capability_unknown.
 *
 * Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/headlessMcpDispatch.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let executeJob;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-headless-mcp-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../../../scheduler.cjs'));
});
afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
afterEach(() => { delete process.env.SM_CLAUDE_BIN; });

function setup(userServers) {
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: userServers }));
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-mcp-main-'));
  const slug = `4830-mcp-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  const dir = path.join(mainCwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp-persona.md'), ['---', 'name: mcp-persona', 'model: sonnet', 'tools: Read, mcp__bilko-host__status', 'mcpServers: bilko-host', '---', 'body'].join('\n'));
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
    const fs = require('fs'); const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'argv.marker'), JSON.stringify(process.argv.slice(2)), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
  return { mainCwd, slug };
}

async function dispatch(mainCwd, slug) {
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-mcp-run-'));
  const marker = path.join(mainCwd, 'argv.marker');
  fs.rmSync(marker, { force: true });
  const result = await executeJob({ slug, cwd: mainCwd, agentType: 'mcp-persona' }, runDir, mainCwd, () => Promise.resolve());
  const argv = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  const logFile = path.join(runDir, `${slug}.log`);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  return { result, argv, log };
}

test('a user-scope declared server spawns with --mcp-config and --strict-mcp-config', async () => {
  const { mainCwd, slug } = setup({ 'bilko-host': { command: 'node', args: ['host.js'] } });
  const { result, argv } = await dispatch(mainCwd, slug);
  expect(result.exitCode).toBe(0);
  const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
  expect(Object.keys(cfg.mcpServers)).toContain('bilko-host');
  expect(argv).toContain('--strict-mcp-config');
});

test('a credentialed declared server is refused capability_credentialed and never spawned', async () => {
  const { mainCwd, slug } = setup({ 'bilko-host': { command: 'node', env: { API_TOKEN: 'x' } } });
  const { result, argv } = await dispatch(mainCwd, slug);
  expect(argv).toBeNull();
  expect(result.personaRefusal.code).toBe('capability_credentialed');
  expect(result.personaRefusal.detail).toContain('API_TOKEN');
});

test('an undefined declared server is refused capability_unknown', async () => {
  const { mainCwd, slug } = setup({});
  const { result, argv, log } = await dispatch(mainCwd, slug);
  expect(argv).toBeNull();
  const detail = "bilko-host (MCP server not defined in ~/.claude.json, <project>/.mcp.json or the project's local scope)";
  expect(result.personaRefusal).toEqual({ code: 'capability_unknown', detail });
  expect(log).toContain(`capability_unknown: ${detail}`);
});
