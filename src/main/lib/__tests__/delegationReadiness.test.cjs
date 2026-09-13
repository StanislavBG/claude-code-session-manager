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
  ensureGuardsInstalled,
  clearGuardsInstalledCache,
  installPrdWriteGuard,
  installDestructiveGitGuard,
  installInlineImplementationGuard,
  probeSchedulerMcpLive,
  clearLiveProbeCache,
  PRD_WRITE_GUARD_SCRIPT,
  DESTRUCTIVE_GIT_GUARD_SCRIPT,
  INLINE_IMPLEMENTATION_GUARD_SCRIPT,
} = require('../delegationReadiness.cjs');
const { todayFile: opsErrorLogTodayFile } = require('../opsErrorLog.cjs');
const {
  writeGuardShims,
  shimPath: guardShimPath,
  hooksDir: guardHooksDir,
  pointerPath: guardPointerPath,
  APP_ROOT: GUARD_APP_ROOT,
} = require('../guardShims.cjs');

const REQUIRED_TOOLS = ['scheduler_create_prd', 'session_manager_help'];

beforeEach(() => {
  clearLiveProbeCache();
  clearGuardsInstalledCache();
});

const tmpDirs = [];
afterEach(async () => {
  clearLiveProbeCache();
  clearGuardsInstalledCache();
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
          hooks: [
            { type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` },
            { type: 'command', command: `node ${INLINE_IMPLEMENTATION_GUARD_SCRIPT}` },
          ],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${DESTRUCTIVE_GIT_GUARD_SCRIPT}` }],
        },
      ],
    },
  });

  return { homeDir, cwd, scriptPath };
}

test('all eight checks pass on a fully-configured project', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const result = await checkDelegationReadiness({ cwd, homeDir });

  expect(result.ok).toBe(true);
  expect(result.checks).toHaveLength(8);
  expect(result.checks.every((c) => c.ok)).toBe(true);
  expect(result.checks.map((c) => c.id)).toEqual([
    'scheduler-mcp',
    'scheduler-mcp-live',
    'scheduler-mcp-project-duplicate',
    'dev-plugin',
    'agent-personas',
    'prd-write-guard',
    'destructive-git-guard',
    'inline-implementation-guard',
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

test('installPrdWriteGuard: writes the canonical STABLE-SHIM-path entry and turns the check green', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(cwd, '.claude', 'settings.json'));

  const r = await installPrdWriteGuard({ cwd, homeDir });
  expect(r.ok).toBe(true);
  expect(r.action).toBe('installed');
  const shimCommand = `node ${guardShimPath('guard-prd-writes.cjs', homeDir)}`;
  expect(r.command).toBe(shimCommand);
  // The shim path survives app upgrades; it must never be the raw app-root script.
  expect(r.command).not.toBe(`node ${PRD_WRITE_GUARD_SCRIPT}`);

  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  expect(written.hooks.PreToolUse).toEqual([
    { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: shimCommand }] },
  ]);
  const result = await checkDelegationReadiness({ cwd, homeDir });
  expect(result.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
}, 15_000);

test('installPrdWriteGuard: is idempotent — a healthy guard is a no-op', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await installPrdWriteGuard({ cwd, homeDir });
  const before = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');

  const again = await installPrdWriteGuard({ cwd, homeDir });
  expect(again.action).toBe('already-installed');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe(before);
});

test('installPrdWriteGuard: refuses on unparseable settings rather than discarding them', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.writeFile(path.join(cwd, '.claude', 'settings.json'), '{ not valid json', 'utf8');

  const r = await installPrdWriteGuard({ cwd, homeDir });
  expect(r.ok).toBe(false);
  expect(r.action).toBe('error');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe('{ not valid json');
});

// ─────────────────────────────── stable-shim indirection (guardShims.cjs)

test('installPrdWriteGuard: repairs a hook pointing at a dead ephemeral _npx cache path to the stable shim path', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  // Shaped exactly like the decay this PRD closes: an absolute path under a
  // version-scoped npx cache dir that no longer exists on this machine.
  const deadNpxPath = path.join(
    homeDir, '.npm', '_npx', '5346543b21849140', 'node_modules',
    'claude-code-session-manager', 'scripts', 'hooks', 'guard-prd-writes.cjs',
  );
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${deadNpxPath}` }] }] },
  });

  const before = await checkDelegationReadiness({ cwd, homeDir });
  expect(before.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(false);

  const r = await installPrdWriteGuard({ cwd, homeDir });
  expect(r.ok).toBe(true);
  expect(r.action).toBe('repaired');
  const shimCommand = `node ${guardShimPath('guard-prd-writes.cjs', homeDir)}`;
  expect(r.command).toBe(shimCommand);

  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  const writeMatchers = written.hooks.PreToolUse.filter((m) => m.matcher === 'Write|Edit|NotebookEdit');
  expect(writeMatchers).toHaveLength(1);
  expect(writeMatchers[0].hooks).toEqual([{ type: 'command', command: shimCommand }]);

  const after = await checkDelegationReadiness({ cwd, homeDir });
  expect(after.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
}, 15_000);

test('checkPrdWriteGuard: reports red — not a false green — when an installed shim\'s pointer has decayed (one hop downstream of the hook command)', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  // makeGreenFixtures seeds a hook pointing DIRECTLY at the app-root script —
  // already healthy, so installPrdWriteGuard would short-circuit as
  // 'already-installed' without ever switching the command to the shim.
  // Remove it first so the install genuinely writes the shim-path command.
  await fsp.rm(path.join(cwd, '.claude', 'settings.json'));
  const r = await installPrdWriteGuard({ cwd, homeDir });
  expect(r.ok).toBe(true);
  expect(r.command).toBe(`node ${guardShimPath('guard-prd-writes.cjs', homeDir)}`);
  const healthy = await checkDelegationReadiness({ cwd, homeDir });
  expect(healthy.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);

  // Corrupt ONLY the pointer — the shim FILE at the hook's command path never
  // moves, which is exactly why checking just its existence isn't enough.
  await writeJson(guardPointerPath(homeDir), { appRoot: path.join(homeDir, 'deleted-app-root') });

  const decayed = await checkDelegationReadiness({ cwd, homeDir });
  const check = decayed.checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(false);
  expect(check.detail).toMatch(/pointer has decayed/);
}, 15_000);

test('checkPrdWriteGuard: accepts BOTH a direct app-root path and the stable shim path as healthy', async () => {
  const { homeDir, cwd } = await makeGreenFixtures(); // direct app-root path, already healthy
  const directResult = await checkDelegationReadiness({ cwd, homeDir });
  expect(directResult.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);

  const shimResult = await writeGuardShims({ homeDir });
  expect(shimResult.ok).toBe(true);
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${guardShimPath('guard-prd-writes.cjs', homeDir)}` }] }] },
  });
  const viaShim = await checkDelegationReadiness({ cwd, homeDir });
  expect(viaShim.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
}, 15_000);

test('installPrdWriteGuard: refuses with ok:false/action:error when the guard shim cannot be written, never writing a hook pointing at a missing shim', async () => {
  const { cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(cwd, '.claude', 'settings.json'));
  const base = await mkTmp('sm-delegation-unwritable-');
  const blocker = path.join(base, 'blocker-file');
  await fsp.writeFile(blocker, 'x', 'utf8');
  const unwritableHomeDir = path.join(blocker, 'home'); // parent segment is a FILE -> mkdir fails

  const r = await installPrdWriteGuard({ cwd, homeDir: unwritableHomeDir });
  expect(r.ok).toBe(false);
  expect(r.action).toBe('error');
  expect(r.error).toBeTruthy();
  expect(fs.existsSync(path.join(cwd, '.claude', 'settings.json'))).toBe(false);
}, 15_000);

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

// ─────────────────────────────── destructive-git-guard / installDestructiveGitGuard

test('destructive-git-guard: fails independently when the hook is missing', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [
            { type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` },
            { type: 'command', command: `node ${INLINE_IMPLEMENTATION_GUARD_SCRIPT}` },
          ],
        },
      ],
    },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'destructive-git-guard');
  expect(check.ok).toBe(false);
  expect(result.ok).toBe(false);
  // the other checks still pass independently
  expect(result.checks.filter((c) => c.id !== 'destructive-git-guard').every((c) => c.ok)).toBe(true);
}, 15_000);

test('destructive-git-guard: fails when the hook names a script that does not exist', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'node /does/not/exist/guard-destructive-git.cjs' }],
        },
      ],
    },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'destructive-git-guard');
  expect(check.ok).toBe(false);
  expect(check.detail).toMatch(/does not exist/);
}, 15_000);

test('installDestructiveGitGuard: writes the canonical STABLE-SHIM-path entry and turns the check green', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
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

  const r = await installDestructiveGitGuard({ cwd, homeDir });
  expect(r.ok).toBe(true);
  expect(r.action).toBe('installed');
  const shimCommand = `node ${guardShimPath('guard-destructive-git.cjs', homeDir)}`;
  expect(r.command).toBe(shimCommand);
  expect(r.command).not.toBe(`node ${DESTRUCTIVE_GIT_GUARD_SCRIPT}`);

  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  // The pre-existing Write|Edit|NotebookEdit matcher (and its hook) survives untouched.
  expect(written.hooks.PreToolUse).toContainEqual(
    { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }] },
  );
  expect(written.hooks.PreToolUse).toContainEqual(
    { matcher: 'Bash', hooks: [{ type: 'command', command: shimCommand }] },
  );

  const result = await checkDelegationReadiness({ cwd, homeDir });
  expect(result.checks.find((c) => c.id === 'destructive-git-guard').ok).toBe(true);
  expect(result.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
}, 15_000);

// The scenario app:install-destructive-git-guard (index.cjs) serves: a project
// that got the first guard via the New Session "Fix it" button and never the
// second (the starry-night-ships reproduction). The handler is a pass-through
// to this function under the shared { cwd } schema, so this is its contract.
test('installDestructiveGitGuard: flips destructive-git-guard FAIL -> PASS on a cwd seeded with only the prd-write-guard hook, by reference, idempotently', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  await writeJson(settingsPath, {
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }] },
      ],
    },
  });

  const before = await checkDelegationReadiness({ cwd, homeDir });
  expect(before.checks.find((c) => c.id === 'destructive-git-guard')).toMatchObject({
    ok: false,
    fixAction: 'install-destructive-git-guard',
    detail: `no guard-destructive-git PreToolUse hook in ${cwd}/.claude/settings.json`,
  });

  const first = await installDestructiveGitGuard({ cwd, homeDir });
  expect(first).toMatchObject({ ok: true, action: 'installed', settingsPath });

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const bash = written.hooks.PreToolUse.filter((m) => m.matcher === 'Bash');
  expect(bash).toHaveLength(1);
  // By reference to the stable shim — never a copy inside the target cwd.
  const shimCommand = `node ${guardShimPath('guard-destructive-git.cjs', homeDir)}`;
  expect(bash[0].hooks).toEqual([{ type: 'command', command: shimCommand }]);
  expect(path.isAbsolute(DESTRUCTIVE_GIT_GUARD_SCRIPT)).toBe(true);
  expect(DESTRUCTIVE_GIT_GUARD_SCRIPT.startsWith(cwd + path.sep)).toBe(false);
  expect(fs.existsSync(path.join(cwd, 'scripts'))).toBe(false);

  const after = await checkDelegationReadiness({ cwd, homeDir });
  expect(after.checks.find((c) => c.id === 'destructive-git-guard').ok).toBe(true);
  expect(after.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);

  // Second press: no-op, byte-identical file.
  const snapshot = fs.readFileSync(settingsPath, 'utf8');
  const second = await installDestructiveGitGuard({ cwd, homeDir });
  expect(second).toMatchObject({ ok: true, action: 'already-installed', settingsPath });
  expect(fs.readFileSync(settingsPath, 'utf8')).toBe(snapshot);
}, 15_000);

test('installDestructiveGitGuard: is idempotent — a healthy guard is a no-op', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const before = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');

  const again = await installDestructiveGitGuard({ cwd, homeDir });
  expect(again.action).toBe('already-installed');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe(before);
});

test('installDestructiveGitGuard: repairs a broken entry in place rather than duplicating it', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'node /does/not/exist/guard-destructive-git.cjs' }],
        },
      ],
    },
  });

  const r = await installDestructiveGitGuard({ cwd, homeDir });
  expect(r.action).toBe('repaired');

  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  const bashMatchers = written.hooks.PreToolUse.filter((m) => m.matcher === 'Bash');
  expect(bashMatchers).toHaveLength(1);
  expect(bashMatchers[0].hooks).toEqual([{ type: 'command', command: `node ${guardShimPath('guard-destructive-git.cjs', homeDir)}` }]);
});

test('installDestructiveGitGuard: refuses on unparseable settings rather than discarding them', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.writeFile(path.join(cwd, '.claude', 'settings.json'), '{ not valid json', 'utf8');

  const r = await installDestructiveGitGuard({ cwd, homeDir });
  expect(r.ok).toBe(false);
  expect(r.action).toBe('error');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe('{ not valid json');
});

// The guard script is EXERCISED here too, same rationale as the
// installPrdWriteGuard end-to-end test above.
test('the installed destructive-git command actually DENIES a shared-tree stash and allows it inside an sm-job/ worktree', async () => {
  const { cwd } = await makeGreenFixtures();
  const { execFileSync } = require('node:child_process');
  const os2 = require('node:os');

  const run = (command, runCwd) => JSON.parse(execFileSync('node', [DESTRUCTIVE_GIT_GUARD_SCRIPT], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: runCwd }),
    encoding: 'utf8',
  }));

  const denied = run('git stash', cwd);
  expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');

  const worktreeCwd = path.join(os2.tmpdir(), 'session-manager-job-worktrees', 'somehash', 'some-slug');
  const allowed = run('git stash', worktreeCwd);
  expect(allowed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

// ─────────────────────────────── inline-implementation-guard / installInlineImplementationGuard

test('inline-implementation-guard: fails independently when the hook is missing (not-installed detail)', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${DESTRUCTIVE_GIT_GUARD_SCRIPT}` }],
        },
      ],
    },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'inline-implementation-guard');
  expect(check.ok).toBe(false);
  expect(check.fixAction).toBe('install-inline-implementation-guard');
  expect(check.detail).toBe(`no guard-inline-implementation PreToolUse hook in ${cwd}/.claude/settings.json — this is a nudge, not a hard gate`);
  expect(result.ok).toBe(false);
  // the other checks still pass independently
  expect(result.checks.filter((c) => c.id !== 'inline-implementation-guard').every((c) => c.ok)).toBe(true);
}, 15_000);

test('inline-implementation-guard: fails with the "would silently guard nothing" detail when the hook names a script that does not exist', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [
            { type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` },
            { type: 'command', command: 'node /does/not/exist/guard-inline-implementation.cjs' },
          ],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${DESTRUCTIVE_GIT_GUARD_SCRIPT}` }],
        },
      ],
    },
  });

  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'inline-implementation-guard');
  expect(check.ok).toBe(false);
  expect(check.detail).toBe(`guard-inline-implementation PreToolUse hook in ${cwd}/.claude/settings.json names a script that does not exist — it would silently guard nothing`);
}, 15_000);

test('inline-implementation-guard: ok when the hook resolves to an existing script file', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const result = await checkDelegationReadiness({ cwd, homeDir });
  const check = result.checks.find((c) => c.id === 'inline-implementation-guard');
  expect(check.ok).toBe(true);
  expect(check.fixAction).toBeNull();
  expect(check.detail).toBe(`guard-inline-implementation PreToolUse hook found in ${cwd}/.claude/settings.json, resolving to ${INLINE_IMPLEMENTATION_GUARD_SCRIPT}`);
}, 15_000);

// installInlineImplementationGuard shares installPrdWriteGuard's matcher
// (Write|Edit|NotebookEdit), so its interesting merge path is APPENDING into
// an existing matcher's hooks array — the branch destructive-git-guard's own
// installer (a different matcher, Bash) never exercises. This is the scenario
// a project that adopted only the PRD-write guard hits.
test('installInlineImplementationGuard: appends into the EXISTING Write|Edit|NotebookEdit matcher rather than pushing a new one, preserving unrelated keys byte-for-byte', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const seeded = {
    someUnrelatedTopLevelKey: { nested: [1, 2, 3], note: 'do not touch' },
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${DESTRUCTIVE_GIT_GUARD_SCRIPT}` }] },
      ],
    },
  };
  await writeJson(settingsPath, seeded);

  const before = await checkDelegationReadiness({ cwd, homeDir });
  expect(before.checks.find((c) => c.id === 'inline-implementation-guard')).toMatchObject({
    ok: false,
    fixAction: 'install-inline-implementation-guard',
  });

  const r = await installInlineImplementationGuard({ cwd, homeDir });
  const inlineShimCommand = `node ${guardShimPath('guard-inline-implementation.cjs', homeDir)}`;
  expect(r).toMatchObject({ ok: true, action: 'installed', settingsPath, command: inlineShimCommand });

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // Exactly ONE Write|Edit|NotebookEdit matcher entry, now carrying BOTH commands.
  const writeMatchers = written.hooks.PreToolUse.filter((m) => m.matcher === 'Write|Edit|NotebookEdit');
  expect(writeMatchers).toHaveLength(1);
  expect(writeMatchers[0].hooks).toEqual([
    { type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` },
    { type: 'command', command: inlineShimCommand },
  ]);
  // The unrelated Bash matcher and every unrelated top-level key survive untouched.
  expect(written.hooks.PreToolUse).toContainEqual(
    { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${DESTRUCTIVE_GIT_GUARD_SCRIPT}` }] },
  );
  expect(written.someUnrelatedTopLevelKey).toEqual(seeded.someUnrelatedTopLevelKey);

  const after = await checkDelegationReadiness({ cwd, homeDir });
  expect(after.checks.find((c) => c.id === 'inline-implementation-guard').ok).toBe(true);
  expect(after.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
  expect(after.checks.find((c) => c.id === 'destructive-git-guard').ok).toBe(true);
}, 15_000);

test('installInlineImplementationGuard: is idempotent — running it twice leaves exactly one entry, byte-identical file on the second press', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }] },
      ],
    },
  });

  const first = await installInlineImplementationGuard({ cwd, homeDir });
  expect(first.action).toBe('installed');
  const snapshot = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');

  const second = await installInlineImplementationGuard({ cwd, homeDir });
  expect(second.action).toBe('already-installed');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe(snapshot);

  const written = JSON.parse(snapshot);
  const writeMatchers = written.hooks.PreToolUse.filter((m) => m.matcher === 'Write|Edit|NotebookEdit');
  expect(writeMatchers).toHaveLength(1);
  expect(writeMatchers[0].hooks.filter((h) => h.command.includes('guard-inline-implementation'))).toHaveLength(1);
});

test('installInlineImplementationGuard: repairs an entry pointing at a now-nonexistent path in place rather than appending a duplicate', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  await writeJson(settingsPath, {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [
            { type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` },
            { type: 'command', command: 'node /does/not/exist/guard-inline-implementation.cjs' },
          ],
        },
      ],
    },
  });

  const r = await installInlineImplementationGuard({ cwd, homeDir });
  expect(r.action).toBe('repaired');

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const writeMatchers = written.hooks.PreToolUse.filter((m) => m.matcher === 'Write|Edit|NotebookEdit');
  expect(writeMatchers).toHaveLength(1);
  const inlineHooks = writeMatchers[0].hooks.filter((h) => h.command.includes('guard-inline-implementation'));
  expect(inlineHooks).toHaveLength(1);
  expect(inlineHooks[0].command).toBe(`node ${guardShimPath('guard-inline-implementation.cjs', homeDir)}`);
});

test('installInlineImplementationGuard: refuses on unparseable settings rather than discarding them', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.writeFile(path.join(cwd, '.claude', 'settings.json'), '{ not valid json', 'utf8');

  const r = await installInlineImplementationGuard({ cwd, homeDir });
  expect(r.ok).toBe(false);
  expect(r.action).toBe('error');
  expect(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe('{ not valid json');
});

// ─────────────────────────────── missing-guard-script refusal (no lying success)

// Renames the real guard script aside for the duration of `fn`, then restores
// it — never deletes a real guard script from the working tree.
async function withGuardScriptMissing(scriptPath, fn) {
  const movedTo = `${scriptPath}.moved-for-test`;
  await fsp.rename(scriptPath, movedTo);
  try {
    await fn();
  } finally {
    await fsp.rename(movedTo, scriptPath);
  }
}

test('all three *_GUARD_SCRIPT constants name a script that exists in this repo', () => {
  expect(fs.existsSync(PRD_WRITE_GUARD_SCRIPT)).toBe(true);
  expect(fs.existsSync(DESTRUCTIVE_GIT_GUARD_SCRIPT)).toBe(true);
  expect(fs.existsSync(INLINE_IMPLEMENTATION_GUARD_SCRIPT)).toBe(true);
});

test('installPrdWriteGuard: refuses when its guard script is missing, and leaves settings.json byte-identical', async () => {
  const { cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  await fsp.rm(settingsPath);

  await withGuardScriptMissing(PRD_WRITE_GUARD_SCRIPT, async () => {
    const r = await installPrdWriteGuard({ cwd });
    expect(r.ok).toBe(false);
    expect(r.action).toBe('error');
    expect(r.error).toContain(PRD_WRITE_GUARD_SCRIPT);
    // Nothing was written — the file must still not exist.
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

test('installPrdWriteGuard: refuses when its guard script is missing, leaving an EXISTING settings.json byte-identical', async () => {
  const { cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const before = fs.readFileSync(settingsPath);

  await withGuardScriptMissing(PRD_WRITE_GUARD_SCRIPT, async () => {
    const r = await installPrdWriteGuard({ cwd });
    expect(r.ok).toBe(false);
    expect(r.action).toBe('error');
    expect(fs.readFileSync(settingsPath).equals(before)).toBe(true);
  });
});

test('installDestructiveGitGuard: refuses when its guard script is missing, and leaves settings.json byte-identical', async () => {
  const { cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  await fsp.rm(settingsPath);

  await withGuardScriptMissing(DESTRUCTIVE_GIT_GUARD_SCRIPT, async () => {
    const r = await installDestructiveGitGuard({ cwd });
    expect(r.ok).toBe(false);
    expect(r.action).toBe('error');
    expect(r.error).toContain(DESTRUCTIVE_GIT_GUARD_SCRIPT);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

test('installDestructiveGitGuard: refuses when its guard script is missing, leaving an EXISTING settings.json byte-identical', async () => {
  const { cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const before = fs.readFileSync(settingsPath);

  await withGuardScriptMissing(DESTRUCTIVE_GIT_GUARD_SCRIPT, async () => {
    const r = await installDestructiveGitGuard({ cwd });
    expect(r.ok).toBe(false);
    expect(r.action).toBe('error');
    expect(fs.readFileSync(settingsPath).equals(before)).toBe(true);
  });
});

test('installInlineImplementationGuard: refuses when its guard script is missing, and leaves settings.json byte-identical', async () => {
  const { cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  await fsp.rm(settingsPath);

  await withGuardScriptMissing(INLINE_IMPLEMENTATION_GUARD_SCRIPT, async () => {
    const r = await installInlineImplementationGuard({ cwd });
    expect(r.ok).toBe(false);
    expect(r.action).toBe('error');
    expect(r.error).toContain(INLINE_IMPLEMENTATION_GUARD_SCRIPT);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

test('installInlineImplementationGuard: refuses when its guard script is missing, leaving an EXISTING settings.json byte-identical', async () => {
  const { cwd } = await makeGreenFixtures();
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const before = fs.readFileSync(settingsPath);

  await withGuardScriptMissing(INLINE_IMPLEMENTATION_GUARD_SCRIPT, async () => {
    const r = await installInlineImplementationGuard({ cwd });
    expect(r.ok).toBe(false);
    expect(r.action).toBe('error');
    expect(fs.readFileSync(settingsPath).equals(before)).toBe(true);
  });
});

test('installInlineImplementationGuard: uses the ABSOLUTE stable-shim path, never a vendored copy — and the shim itself resolves by REFERENCE, not a copy', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }] }] },
  });

  const r = await installInlineImplementationGuard({ cwd, homeDir });
  const shimFile = guardShimPath('guard-inline-implementation.cjs', homeDir);
  expect(path.isAbsolute(shimFile)).toBe(true);
  expect(r.command).toBe(`node ${shimFile}`);
  expect(shimFile.startsWith(cwd + path.sep)).toBe(false);
  expect(fs.existsSync(path.join(cwd, 'scripts'))).toBe(false);

  // The shim is not a vendored copy of the real guard — it's a pointer-file
  // indirection that names the real script's absolute path, which still
  // lives only inside this repo.
  const pointer = JSON.parse(fs.readFileSync(guardPointerPath(homeDir), 'utf8'));
  expect(pointer.appRoot).toBe(GUARD_APP_ROOT);
  const shimSource = fs.readFileSync(shimFile, 'utf8');
  expect(shimSource).toContain('guard-inline-implementation.cjs');
  expect(shimSource).not.toContain(INLINE_IMPLEMENTATION_GUARD_SCRIPT);
});

// ─────────────────────────────── ensureGuardsInstalled (self-heal — PRD: guards-auto-install)
//
// The "Fix It does nothing" incident: installPrdWriteGuard/installDestructiveGitGuard/
// installInlineImplementationGuard above were only ever reachable from a human
// pressing the New Session card's Fix It button, so every project started red
// forever. ensureGuardsInstalled is the self-heal entry point invoked from the
// app:delegation-readiness IPC handler BEFORE checkDelegationReadiness runs.

/** Fabricates a linked git worktree pointing at `main`, without shelling out to git. */
async function makeLinkedWorktreeFixture(mk) {
  const main = await mk('sm-ensure-guards-main-');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  const worktree = await mk('sm-ensure-guards-worktree-');
  const worktreeName = 'sm-epic-testfixture';
  const worktreeGitFile = path.join(worktree, '.git');
  const adminDir = path.join(main, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(adminDir, { recursive: true });
  // Round-trip back-reference real `git worktree add` writes — required by
  // worktreeMainRootOf's verification (see opsRootAbsoluteCwd.test.cjs).
  fs.writeFileSync(path.join(adminDir, 'gitdir'), `${worktreeGitFile}\n`, 'utf8');
  fs.writeFileSync(worktreeGitFile, `gitdir: ${adminDir}\n`, 'utf8');
  return { main, worktree };
}

test('ensureGuardsInstalled: installs all three guards into a fresh project with no .claude/settings.json', async () => {
  const cwd = await mkTmp('sm-ensure-guards-fresh-');
  const homeDir = await mkTmp('sm-ensure-guards-fresh-home-');

  const result = await ensureGuardsInstalled(cwd, { homeDir });
  expect(result.ok).toBe(true);
  expect(result.root).toBe(cwd);
  expect(result.guards['prd-write-guard'].action).toBe('installed');
  expect(result.guards['destructive-git-guard'].action).toBe('installed');
  expect(result.guards['inline-implementation-guard'].action).toBe('installed');

  const readiness = await checkDelegationReadiness({ cwd, homeDir });
  expect(readiness.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
  expect(readiness.checks.find((c) => c.id === 'destructive-git-guard').ok).toBe(true);
  expect(readiness.checks.find((c) => c.id === 'inline-implementation-guard').ok).toBe(true);
}, 15_000);

test('ensureGuardsInstalled: a second call against an already-healthy project performs no write (memoized per cwd)', async () => {
  const cwd = await mkTmp('sm-ensure-guards-idempotent-');
  const homeDir = await mkTmp('sm-ensure-guards-idempotent-home-');
  const settingsPath = path.join(cwd, '.claude', 'settings.json');

  const first = await ensureGuardsInstalled(cwd, { homeDir });
  expect(first.ok).toBe(true);
  const before = fs.statSync(settingsPath).mtimeMs;

  const second = await ensureGuardsInstalled(cwd, { homeDir });
  expect(second).toBe(first); // memoized — same resolved outcome, no re-run
  const after = fs.statSync(settingsPath).mtimeMs;
  expect(after).toBe(before);
}, 15_000);

test('ensureGuardsInstalled: malformed settings.json does not throw and leaves the guard row red with its manual fixAction intact', async () => {
  const cwd = await mkTmp('sm-ensure-guards-malformed-');
  const homeDir = await mkTmp('sm-ensure-guards-malformed-home-');
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, '{ not valid json', 'utf8');

  const result = await ensureGuardsInstalled(cwd, { homeDir });
  expect(result.ok).toBe(false);
  expect(result.guards['prd-write-guard']).toMatchObject({ ok: false, action: 'error' });
  // never silently discarded the human's unparseable file
  expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not valid json');

  const readiness = await checkDelegationReadiness({ cwd, homeDir });
  const check = readiness.checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(false);
  expect(check.fixAction).toBe('install-prd-write-guard');
}, 15_000);

test('ensureGuardsInstalled: a failed attempt is NOT permanently cached — a later call retries once the underlying problem is fixed', async () => {
  const cwd = await mkTmp('sm-ensure-guards-retry-');
  const homeDir = await mkTmp('sm-ensure-guards-retry-home-');
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, '{ not valid json', 'utf8');

  const first = await ensureGuardsInstalled(cwd, { homeDir });
  expect(first.ok).toBe(false);

  // Fixed by hand, WITHOUT an app restart / cache clear.
  await fsp.writeFile(settingsPath, '{}', 'utf8');

  const second = await ensureGuardsInstalled(cwd, { homeDir });
  expect(second.ok).toBe(true);
  expect(second.guards['prd-write-guard'].action).toBe('installed');
}, 15_000);

test('ensureGuardsInstalled: a nonexistent cwd never throws, is reported ok:false, and never resurrects the deleted folder', async () => {
  const homeDir = await mkTmp('sm-ensure-guards-missing-home-');
  const missingCwd = path.join(os.tmpdir(), `sm-ensure-guards-does-not-exist-${Date.now()}`, 'nested', 'project');

  const result = await ensureGuardsInstalled(missingCwd, { homeDir });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/does not exist on disk/);
  // Never `mkdir -p`s a deleted project back into existence as a side effect.
  expect(fs.existsSync(missingCwd)).toBe(false);
}, 15_000);

test('ensureGuardsInstalled: preserves a pre-existing unrelated PreToolUse matcher and hook', async () => {
  const cwd = await mkTmp('sm-ensure-guards-unrelated-');
  const homeDir = await mkTmp('sm-ensure-guards-unrelated-home-');
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const unrelatedMatcher = { matcher: 'SomeOtherTool', hooks: [{ type: 'command', command: 'node /some/unrelated-hook.cjs' }] };
  await writeJson(settingsPath, { someUnrelatedTopLevelKey: 'keep-me', hooks: { PreToolUse: [unrelatedMatcher] } });

  const result = await ensureGuardsInstalled(cwd, { homeDir });
  expect(result.ok).toBe(true);

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(written.someUnrelatedTopLevelKey).toBe('keep-me');
  expect(written.hooks.PreToolUse).toContainEqual(unrelatedMatcher);
}, 15_000);

test('ensureGuardsInstalled: a worktree cwd installs into the MAIN tree root, never the ephemeral worktree', async () => {
  const { main, worktree } = await makeLinkedWorktreeFixture(mkTmp);
  const homeDir = await mkTmp('sm-ensure-guards-worktree-home-');

  const result = await ensureGuardsInstalled(worktree, { homeDir });
  expect(result.ok).toBe(true);
  expect(result.root).toBe(main);

  expect(fs.existsSync(path.join(main, '.claude', 'settings.json'))).toBe(true);
  expect(fs.existsSync(path.join(worktree, '.claude', 'settings.json'))).toBe(false);

  const readiness = await checkDelegationReadiness({ cwd: main, homeDir });
  expect(readiness.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
}, 15_000);

test('ensureGuardsInstalled: records every auto-install attempt in the ops error log under scope "delegationReadiness"', async () => {
  const cwd = await mkTmp('sm-ensure-guards-logged-');
  const homeDir = await mkTmp('sm-ensure-guards-logged-home-');

  await ensureGuardsInstalled(cwd, { homeDir });

  const logFile = opsErrorLogTodayFile(cwd);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const delegationLines = lines.filter((l) => l.scope === 'delegationReadiness');
  expect(delegationLines.map((l) => l.meta?.guard)).toEqual(
    expect.arrayContaining(['prd-write-guard', 'destructive-git-guard', 'inline-implementation-guard']),
  );
  expect(delegationLines.every((l) => l.level === 'info')).toBe(true);
  expect(delegationLines.every((l) => l.meta?.action === 'installed')).toBe(true);
}, 15_000);
