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
const { checkDelegationReadiness, installPrdWriteGuard, PRD_WRITE_GUARD_SCRIPT } = require('../delegationReadiness.cjs');


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

test('prd-write-guard: a RELATIVE hook command still passes WHEN it resolves against cwd', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  // This is the form in session-manager's OWN .claude/settings.json, which is
  // legitimate there precisely because the script exists at that relative path.
  // The `ok` check resolves against cwd rather than demanding an absolute
  // path, so this repo's own settings keep passing — what it will NOT accept
  // is the same string in a project where nothing sits at that path.
  await fsp.mkdir(path.join(cwd, 'scripts', 'hooks'), { recursive: true });
  await fsp.writeFile(path.join(cwd, 'scripts', 'hooks', 'guard-prd-writes.cjs'), '// stub', 'utf8');
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|NotebookEdit',
        hooks: [{ type: 'command', command: 'node scripts/hooks/guard-prd-writes.cjs' }],
      }],
    },
  });

  const check = checkDelegationReadiness({ cwd, homeDir }).checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(true);
});

test('missing cwd/.claude/settings.json entirely is treated as guard-absent, not a throw', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await fsp.rm(path.join(cwd, '.claude', 'settings.json'));

  expect(() => checkDelegationReadiness({ cwd, homeDir })).not.toThrow();
  const result = checkDelegationReadiness({ cwd, homeDir });
  expect(result.checks.find((c) => c.id === 'prd-write-guard').ok).toBe(false);
});

// ─────────────────────────────── ok must mean "would actually run"

test('prd-write-guard: a hook naming a NON-EXISTENT script fails, and says why', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|NotebookEdit',
        // The exact paste-the-relative-string failure mode: resolves nowhere,
        // exits non-zero without code 2 => non-blocking error => guards nothing.
        hooks: [{ type: 'command', command: 'node scripts/hooks/guard-prd-writes.cjs' }],
      }],
    },
  });

  const check = checkDelegationReadiness({ cwd, homeDir }).checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(false);
  expect(check.detail).toMatch(/does not exist/);
});

test('prd-write-guard: an ABSOLUTE path to the real guard script passes', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|NotebookEdit',
        hooks: [{ type: 'command', command: `node ${PRD_WRITE_GUARD_SCRIPT}` }],
      }],
    },
  });

  const check = checkDelegationReadiness({ cwd, homeDir }).checks.find((c) => c.id === 'prd-write-guard');
  expect(check.ok).toBe(true);
  expect(check.fixAction).toBeNull();
});

test('prd-write-guard: a failing check advertises the one-press install action', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: [] } });

  const result = checkDelegationReadiness({ cwd, homeDir });
  expect(result.checks.find((c) => c.id === 'prd-write-guard').fixAction).toBe('install-prd-write-guard');
  // No other check claims an installer it doesn't have.
  expect(result.checks.filter((c) => c.id !== 'prd-write-guard').every((c) => c.fixAction === null)).toBe(true);
});

// ─────────────────────────────── installPrdWriteGuard

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
  expect(checkDelegationReadiness({ cwd, homeDir }).checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
});

test('installPrdWriteGuard: MERGES into an existing hooks block instead of clobbering it', async () => {
  const { cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    model: 'opus',
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo post' }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] },
        { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: 'echo other' }] },
      ],
    },
  });

  await installPrdWriteGuard({ cwd });
  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));

  expect(written.model).toBe('opus');
  expect(written.hooks.PostToolUse).toHaveLength(1);
  expect(written.hooks.PreToolUse.find((m) => m.matcher === 'Bash').hooks[0].command).toBe('echo bash');
  const target = written.hooks.PreToolUse.find((m) => m.matcher === 'Write|Edit|NotebookEdit');
  expect(target.hooks.map((h) => h.command)).toEqual(['echo other', `node ${PRD_WRITE_GUARD_SCRIPT}`]);
});

test('installPrdWriteGuard: REPAIRS a broken relative entry in place rather than duplicating it', async () => {
  const { homeDir, cwd } = await makeGreenFixtures();
  await writeJson(path.join(cwd, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|NotebookEdit',
        hooks: [{ type: 'command', command: 'node scripts/hooks/guard-prd-writes.cjs' }],
      }],
    },
  });

  const r = await installPrdWriteGuard({ cwd });
  expect(r.action).toBe('repaired');

  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  const target = written.hooks.PreToolUse.find((m) => m.matcher === 'Write|Edit|NotebookEdit');
  expect(target.hooks).toHaveLength(1);
  expect(target.hooks[0].command).toBe(`node ${PRD_WRITE_GUARD_SCRIPT}`);
  expect(checkDelegationReadiness({ cwd, homeDir }).checks.find((c) => c.id === 'prd-write-guard').ok).toBe(true);
});

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
