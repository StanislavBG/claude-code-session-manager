/**
 * delegationReadiness.test.cjs — unit tests for the "can this project
 * actually delegate?" probe. Uses a temp HOME and a temp cwd so the real
 * ~/.claude and this repo's own config are never touched.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/delegationReadiness.test.cjs
 */

import { test, expect, afterEach, beforeEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  checkDelegationReadiness,
  installPrdWriteGuard,
  probeSchedulerMcpLive,
  clearLiveProbeCache,
  PRD_WRITE_GUARD_SCRIPT,
} = require('../delegationReadiness.cjs');

const REQUIRED_TOOLS = ['scheduler_create_prd', 'session_manager_help'];

beforeEach(() => {
  clearLiveProbeCache();
});

const tmpDirs = [];
afterEach(async () => {
  clearLiveProbeCache();
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

/** A stub stdio MCP server: answers initialize + tools/list over stdin/stdout. */
async function writeAnsweringStub(dir, { toolNames = REQUIRED_TOOLS, countFile = null } = {}) {
  const scriptPath = path.join(dir, 'stub-mcp-server.cjs');
  const body = `
    'use strict';
    const readline = require('node:readline');
    ${countFile ? `require('node:fs').appendFileSync(${JSON.stringify(countFile)}, 'x\\n');` : ''}
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '1' } } }) + '\\n');
      } else if (msg.id === 2) {
        const tools = ${JSON.stringify(toolNames)}.map((name) => ({ name }));
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }) + '\\n');
      }
    });
  `;
  await fsp.writeFile(scriptPath, body, 'utf8');
  return scriptPath;
}

/** A stub that never responds to anything — exercises the timeout path. */
async function writeSilentStub(dir) {
  const scriptPath = path.join(dir, 'silent-mcp-server.cjs');
  await fsp.writeFile(scriptPath, 'process.stdin.resume();\n', 'utf8');
  return scriptPath;
}

async function makeGreenFixtures() {
  const homeDir = await mkTmp('sm-delegation-home-');
  const cwd = await mkTmp('sm-delegation-cwd-');

  const scriptPath = await writeAnsweringStub(homeDir);
  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: { 'session-manager-scheduler': { type: 'stdio', command: 'node', args: [scriptPath] } },
  });
  await writeJson(path.join(homeDir, '.claude', 'settings.json'), {
    enabledPlugins: { 'session-manager-dev@session-manager': true },
  });
  await fsp.mkdir(path.join(homeDir, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(homeDir, '.claude', 'agents', 'dev-lead.md'), '# dev-lead', 'utf8');
  // The canonical, sanctioned form: an ABSOLUTE path to session-manager's own
  // guard script (installPrdWriteGuard's "reference, never vendor" decision).
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }],
        },
      ],
    },
  });

  return { homeDir, cwd, scriptPath };
}

test('all six checks pass on a fully-configured project', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const result = await checkDelegationReadiness({ cwd, homeDir });

  expect(result.ok).toBe(true);
  expect(result.checks).toHaveLength(6);
  expect(result.checks.every((c) => c.ok)).toBe(true);
  expect(result.checks.map((c) => c.id)).toEqual([
    'scheduler-mcp',
    'scheduler-mcp-live',
    'scheduler-mcp-project-duplicate',
    'dev-plugin',
    'agent-personas',
    'prd-write-guard',
  ]);
}, 15_000);

test('scheduler-mcp: passes via project-scope .mcp.json even without user scope', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), { mcpServers: {} });
  await writeJson(path.join(cwd, '.mcp.json'), {
    mcpServers: { 'session-manager-scheduler': { command: 'node', args: [] } },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp');
  expect(check.ok).toBe(true);
}, 15_000);

test('scheduler-mcp: fails with a runnable fix when absent from both scopes', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), { mcpServers: {} });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
  expect(check.fix).toMatch(/^claude mcp add session-manager-scheduler --scope user/);
  expect(check.fix).toContain('scheduler-mcp-server.cjs');
}, 15_000);

test('scheduler-mcp: fails when the user-scope script path is RELATIVE', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: { 'session-manager-scheduler': { command: 'node', args: ['scripts/scheduler-mcp-server.cjs'] } },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp');
  expect(check.ok).toBe(false);
  expect(check.detail).toMatch(/non-absolute/);
  expect(check.fix).toMatch(/^claude mcp add session-manager-scheduler --scope user/);
  // Live probe has nothing runnable to trust, so it must not report ready either.
  expect(result.checks.find((c) => c.id === 'scheduler-mcp-live').skipped).toBe(true);
}, 15_000);

test('scheduler-mcp: fails when the user-scope script path is absolute but MISSING', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: { 'session-manager-scheduler': { command: 'node', args: [path.join(homeDir, 'does-not-exist.cjs')] } },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp');
  expect(check.ok).toBe(false);
  expect(check.detail).toMatch(/no longer exists/);
}, 15_000);

test('dev-plugin: fails independently when enabledPlugins is missing the key', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude', 'settings.json'), { enabledPlugins: {} });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'dev-plugin');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
  expect(check.fix).toBeTruthy();
  // the other checks still pass independently
  expect(result.checks.filter((c) => c.id !== 'dev-plugin').every((c) => c.ok)).toBe(true);
}, 15_000);

test('agent-personas: fails independently when ~/.claude/agents has no personas', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(homeDir, '.claude', 'agents', 'dev-lead.md'));

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'agent-personas');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
}, 15_000);

test('agent-personas: passes via project-scope .claude/agents/ even without global personas', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(homeDir, '.claude', 'agents'), { recursive: true, force: true });
  await fsp.mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.claude', 'agents', 'builder.md'), '# builder', 'utf8');

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'agent-personas');
  expect(check.ok).toBe(true);
}, 15_000);

test('prd-write-guard: fails independently when the hook is missing', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: [] } });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
}, 15_000);

test('unparseable JSON files yield ok:false with a detail, never a throw', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fs.promises.writeFile(path.join(homeDir, '.claude.json'), '{ not valid json', 'utf8');
  await fs.promises.writeFile(path.join(homeDir, '.claude', 'settings.json'), '{ not valid json', 'utf8');
  await fs.promises.writeFile(path.join(cwd, '.claude', 'settings.json'), '{ not valid json', 'utf8');

  await expect(checkDelegationReadiness({ cwd, homeDir })).resolves.toBeTruthy();
  const result = await checkDelegationReadiness({ cwd, homeDir });

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
}, 15_000);

// ─────────────────────────────── scheduler-mcp-project-duplicate

test('scheduler-mcp-project-duplicate: warns when both scopes register the server', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.mcp.json'), {
    mcpServers: { 'session-manager-scheduler': { command: 'node', args: ['scripts/scheduler-mcp-server.cjs'] } },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp-project-duplicate');
  expect(check.ok).toBe(true);
  expect(check.warn).toBe(true);
  expect(check.detail).toMatch(/user scope is canonical/);
  // A warning never fails the overall gate.
  expect(result.ok).toBe(true);
}, 15_000);

test('scheduler-mcp-project-duplicate: no warning when only user scope is registered', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'scheduler-mcp-project-duplicate');
  expect(check.ok).toBe(true);
  expect(check.warn).toBe(false);
}, 15_000);

// ─────────────────────────────── scheduler-mcp-live

test('scheduler-mcp-live: ok when the server answers tools/list with both required tools', async () => {
  const dir = await mkTmp('sm-live-probe-');
  const scriptPath = await writeAnsweringStub(dir);

  const result = await probeSchedulerMcpLive({ command: 'node', args: [scriptPath], env: {} });
  expect(result.ok).toBe(true);
  expect(result.detail).toContain('scheduler_create_prd');
}, 15_000);

test('scheduler-mcp-live: fails naming the missing tool when the server answers WITHOUT it', async () => {
  const dir = await mkTmp('sm-live-probe-');
  const scriptPath = await writeAnsweringStub(dir, { toolNames: ['scheduler_create_prd'] });

  const result = await probeSchedulerMcpLive({ command: 'node', args: [scriptPath], env: {} });
  expect(result.ok).toBe(false);
  expect(result.detail).toContain('session_manager_help');
}, 15_000);

test('scheduler-mcp-live: times out (bounded) against a server that never answers, and kills the child', async () => {
  const dir = await mkTmp('sm-live-probe-');
  const scriptPath = await writeSilentStub(dir);

  const start = Date.now();
  const result = await probeSchedulerMcpLive({ command: 'node', args: [scriptPath], env: {} });
  const elapsed = Date.now() - start;

  expect(result.ok).toBe(false);
  expect(result.detail).toBe('timeout');
  expect(elapsed).toBeLessThan(15_000);
}, 20_000);

test('scheduler-mcp-live: is skipped, not failed, when scheduler-mcp already failed', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), { mcpServers: {} });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const live = result.checks.find((c) => c.id === 'scheduler-mcp-live');
  expect(live.ok).toBe(true);
  expect(live.skipped).toBe(true);
  // One red row for the registration failure, not two.
  expect(result.checks.filter((c) => !c.ok)).toHaveLength(1);
}, 15_000);

test('scheduler-mcp-live: memoizes the probe per registration signature within the TTL', async () => {
  const dir = await mkTmp('sm-live-probe-');
  const countFile = path.join(dir, 'spawn-count.txt');
  const scriptPath = await writeAnsweringStub(dir, { countFile });

  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: { 'session-manager-scheduler': { type: 'stdio', command: 'node', args: [scriptPath] } },
  });

  await checkDelegationReadiness({ cwd, homeDir });
  await checkDelegationReadiness({ cwd, homeDir });

  const spawnCount = (await fsp.readFile(countFile, 'utf8')).trim().split('\n').filter(Boolean).length;
  expect(spawnCount).toBe(1);
}, 15_000);

// ─────────────────────────────── installPrdWriteGuard (unchanged behavior)

test('installPrdWriteGuard: writes the canonical ABSOLUTE-path entry and turns the check green', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(cwd, '.claude', 'settings.json'));

  const r = await installPrdWriteGuard({ cwd });
  expect(r.ok).toBe(true);
  expect(r.action).toBe('installed');
  expect(r.command).toBe(`node ${PRD_WRITE_GUARD_SCRIPT}`);

  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  expect(written.hooks.PreToolUse).toEqual([
    { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }] },
  ]);
  const result = await checkDelegationReadiness({ cwd, homeDir });
  expect(result.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
}, 15_000);

test('installPrdWriteGuard: is idempotent — a healthy guard is a no-op', async () => {
  const { cwd } = await makeGreenFixtures();
  await installPrdWriteGuard({ cwd });
  const before = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');

  const again = await installPrdWriteGuard({ cwd });
  expect(again.action).toBe('already-installed');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe(before);
});

test('installPrdWriteGuard: refuses on unparseable settings rather than discarding them', async () => {
  const { cwd } = await makeGreenFixtures();
  await fsp.writeFile(path.join(cwd, '.claude', 'settings.json'), '{ not valid json', 'utf8');

  const r = await installPrdWriteGuard({ cwd });
  expect(r.ok).toBe(false);
  expect(r.action).toBe('error');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe('{ not valid json');
});

// The guard script is not just referenced — it is EXERCISED here, so the
// "certifies a config that has never been proven to run" gap is closed by a
// real end-to-end run of the exact command installPrdWriteGuard writes.
test('the installed command actually DENIES a scheduler PRD write and allows a normal one', async () => {
  const { cwd } = await makeGreenFixtures();
  const { execFileSync } = require('node:child_process');

  const run = (toolInput) => JSON.parse(execFileSync('node', [PRD_WRITE_GUARD_SCRIPT], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: toolInput, cwd }),
    encoding: 'utf8',
  }));

  const denied = run({ file_path: path.join(cwd, 'session-manager-operations', 'scheduler', 'prds', '1234-x.md'), content: '# x' });
  expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');

  const allowed = run({ file_path: path.join(cwd, 'src', 'x.ts'), content: 'x' });
  expect(allowed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});
