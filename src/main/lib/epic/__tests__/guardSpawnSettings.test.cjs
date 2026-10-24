/**
 * guardSpawnSettings.test.cjs — temp HOME + temp cwd; never touches real ~/.claude.
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/guardSpawnSettings.test.cjs
 */
import { test, expect, afterEach, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildGuardSpawnSettings, writeGuardSpawnSettingsFile } = require('../guardSpawnSettings.cjs');
const { GUARD_DEFS } = require('../delegationReadiness.cjs');
const { shimPath } = require('../../guardShims.cjs');
const { nodeShellCommand } = require('../../appRuntime.cjs');

let home;
let cwd;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-cwd-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function writeCwdSettings(defs) {
  const real = path.join(home, 'real-scripts');
  fs.mkdirSync(real, { recursive: true });
  const PreToolUse = defs.map((def) => {
    const script = path.join(real, def.scriptBasename);
    fs.writeFileSync(script, '');
    return { matcher: def.matcher, hooks: [{ type: 'command', command: `node ${script}` }] };
  });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse } }));
}

test('all four guards for an empty cwd, shared matcher entry', () => {
  const s = buildGuardSpawnSettings({ spawnCwd: cwd, homeDir: home });
  const defs = Object.values(GUARD_DEFS);
  const matchers = new Set(defs.map((d) => d.matcher));
  expect(s.hooks.PreToolUse).toHaveLength(matchers.size);
  const cmds = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  expect(cmds.sort()).toEqual(defs.map((d) => nodeShellCommand(shimPath(d.scriptBasename, home))).sort());
  const write = s.hooks.PreToolUse.find((e) => e.matcher === 'Write|Edit|NotebookEdit');
  expect(write.hooks).toHaveLength(2);
  for (const e of s.hooks.PreToolUse) for (const h of e.hooks) expect(h.type).toBe('command');
});

test('dedupes a guard already effective in spawnCwd settings', () => {
  writeCwdSettings([GUARD_DEFS.destructiveGit]);
  const s = buildGuardSpawnSettings({ spawnCwd: cwd, homeDir: home });
  const cmds = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  expect(cmds).toHaveLength(3);
  expect(cmds.some((c) => c.includes('guard-destructive-git'))).toBe(false);
});

test('null when all four are effective', async () => {
  writeCwdSettings(Object.values(GUARD_DEFS));
  expect(buildGuardSpawnSettings({ spawnCwd: cwd, homeDir: home })).toBeNull();
  expect(await writeGuardSpawnSettingsFile({ spawnCwd: cwd, homeDir: home })).toBeNull();
});

test('identical content gives same path and no rewrite', async () => {
  const a = await writeGuardSpawnSettingsFile({ spawnCwd: cwd, homeDir: home });
  expect(a).toMatch(/spawn-settings[\\/]guards-[0-9a-f]{12}\.json$/);
  expect(path.isAbsolute(a)).toBe(true);
  expect(JSON.parse(fs.readFileSync(a, 'utf8')).hooks.PreToolUse.length).toBeGreaterThan(0);
  const past = new Date(Date.now() - 100000);
  fs.utimesSync(a, past, past);
  const mtime = fs.statSync(a).mtimeMs;
  const b = await writeGuardSpawnSettingsFile({ spawnCwd: cwd, homeDir: home });
  expect(b).toBe(a);
  expect(fs.statSync(a).mtimeMs).toBe(mtime);
});

test('shim failure gives null', async () => {
  const r = await writeGuardSpawnSettingsFile({
    spawnCwd: cwd,
    homeDir: home,
    deps: { ensureShims: async () => ({ ok: false, action: 'error', error: 'boom' }) },
  });
  expect(r).toBeNull();
  expect(fs.existsSync(path.join(home, '.claude', 'session-manager', 'spawn-settings'))).toBe(false);
});
