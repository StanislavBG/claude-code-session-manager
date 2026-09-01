/**
 * delegationReadiness.test.cjs — unit tests for the "can this project
 * actually delegate?" probe. Uses a temp HOME and a temp cwd so the real
 * ~/.claude and this repo's own config are never touched.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/delegationReadiness.test.cjs
 */

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { checkDelegationReadiness } = require('../delegationReadiness.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

async function writeJson(absPath, value) {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, JSON.stringify(value), 'utf8');
}

async function makeGreenFixtures() {
  const homeDir = await mkTmp('sm-delegation-home-');
  const cwd = await mkTmp('sm-delegation-cwd-');

  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: { 'session-manager-scheduler': { type: 'stdio', command: 'node', args: [] } },
  });
  await writeJson(path.join(homeDir, '.claude', 'settings.json'), {
    enabledPlugins: { 'session-manager-dev@session-manager': true },
  });
  await fsp.mkdir(path.join(homeDir, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(homeDir, '.claude', 'agents', 'dev-lead.md'), '# dev-lead', 'utf8');
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [{ type: 'command', command: 'node scripts/hooks/guard-prd-writes.cjs' }],
        },
      ],
    },
  });

  return { homeDir, cwd };
}

test('all four checks pass on a fully-configured project', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const result = checkDelegationReadiness({ cwd, homeDir });

  expect(result.ok).toBe(true);
  expect(result.checks).toHaveLength(4);
  expect(result.checks.every((c) => c.ok)).toBe(true);
  expect(result.checks.map((c) => c.id)).toEqual([
    'scheduler-mcp',
    'dev-plugin',
    'agent-personas',
    'prd-write-guard',
  ]);
});

test('scheduler-mcp: passes via project-scope .mcp.json even without user scope', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), { mcpServers: {} });
  await writeJson(path.join(cwd, '.mcp.json'), {
    mcpServers: { 'session-manager-scheduler': { command: 'node', args: [] } },
  });

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp');
  expect(check.ok).toBe(true);
  expect(result.ok).toBe(true);
});

test('scheduler-mcp: fails with a runnable fix when absent from both scopes', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), { mcpServers: {} });

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
  expect(check.fix).toMatch(/^claude mcp add session-manager-scheduler --scope user/);
  expect(check.fix).toContain('scheduler-mcp-server.cjs');
});

test('dev-plugin: fails independently when enabledPlugins is missing the key', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude', 'settings.json'), { enabledPlugins: {} });

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'dev-plugin');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
  expect(check.fix).toBeTruthy();
  // the other three checks still pass independently
  expect(result.checks.filter((c) => c.id !== 'dev-plugin').every((c) => c.ok)).toBe(true);
});

test('agent-personas: fails independently when ~/.claude/agents has no personas', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(homeDir, '.claude', 'agents', 'dev-lead.md'));

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'agent-personas');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
  expect(result.checks.filter((c) => c.id !== 'agent-personas').every((c) => c.ok)).toBe(true);
});

test('agent-personas: passes via project-scope .claude/agents/ even without global personas', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(homeDir, '.claude', 'agents'), { recursive: true, force: true });
  await fsp.mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.claude', 'agents', 'builder.md'), '# builder', 'utf8');

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'agent-personas');
  expect(check.ok).toBe(true);
  expect(result.ok).toBe(true);
});

test('agent-personas: fails when the directory does not exist at all', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(homeDir, '.claude', 'agents'), { recursive: true, force: true });

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'agent-personas');
  expect(check.ok).toBe(false);
});

test('prd-write-guard: fails independently when the hook is missing', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: [] } });

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
  expect(result.checks.filter((c) => c.id !== 'prd-write-guard').every((c) => c.ok)).toBe(true);
});

test('unparseable JSON files yield ok:false with a detail, never a throw', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fs.promises.writeFile(path.join(homeDir, '.claude.json'), '{ not valid json', 'utf8');
  await fs.promises.writeFile(path.join(homeDir, '.claude', 'settings.json'), '{ not valid json', 'utf8');
  await fs.promises.writeFile(path.join(cwd, '.claude', 'settings.json'), '{ not valid json', 'utf8');

  expect(() => checkDelegationReadiness({ cwd, homeDir })).not.toThrow();
  const result = checkDelegationReadiness({ cwd, homeDir });

  const scheduler = result.checks.find((c) => c.id === 'scheduler-mcp');
  const devPlugin = result.checks.find((c) => c.id === 'dev-plugin');
  const guard = result.checks.find((c) => c.id === 'prd-write-guard');
  expect(scheduler.ok).toBe(false);
  expect(scheduler.detail).toBeTruthy();
  expect(devPlugin.ok).toBe(false);
  expect(devPlugin.detail).toBeTruthy();
  expect(guard.ok).toBe(false);
  expect(guard.detail).toBeTruthy();
  expect(result.ok).toBe(false);
});

test('prd-write-guard: fix string names the guard script by an absolute, existing path', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: [] } });

  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(false);

  const match = check.fix.match(/node (\S+guard-prd-writes\.cjs)/);
  expect(match).toBeTruthy();
  const scriptPath = match[1];
  expect(scriptPath.startsWith('/')).toBe(true);
  expect(fs.existsSync(scriptPath)).toBe(true);
});

test('prd-write-guard: detection still passes for session-manager\'s own RELATIVE hook command', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  // makeGreenFixtures already installs the relative form used in this repo's
  // own .claude/settings.json — assert it explicitly so a future tightening
  // of the `ok` check to an exact/absolute match is caught here.
  const result = checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(true);
});

test('missing cwd/.claude/settings.json entirely is treated as guard-absent, not a throw', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(cwd, '.claude', 'settings.json'));

  expect(() => checkDelegationReadiness({ cwd, homeDir })).not.toThrow();
  const result = checkDelegationReadiness({ cwd, homeDir });
  expect(result.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(false);
});
