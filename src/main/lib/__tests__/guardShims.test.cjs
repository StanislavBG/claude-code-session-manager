/**
 * guardShims.test.cjs — unit tests for the stable, app-upgrade-proof guard
 * hook indirection (guardShims.cjs). Uses a temp "home" dir per test so the
 * real ~/.claude is never touched.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/guardShims.test.cjs
 */

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  APP_ROOT,
  GUARD_NAMES,
  hooksDir,
  pointerPath,
  shimPath,
  writeGuardShims,
  guardShimsExist,
} = require('../guardShims.cjs');

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

/** Run a guard (by absolute path, e.g. a shim) as a child process, same
 *  pattern delegationReadiness.test.cjs uses to exercise the real guards —
 *  NEVER require() a guard/shim in-process, since its main() calls
 *  process.exit(0) as a require-time side effect. */
function runGuard(scriptPath, { toolName = 'Write', toolInput, cwd }) {
  return JSON.parse(execFileSync('node', [scriptPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    encoding: 'utf8',
  }));
}

test('writeGuardShims: writes the pointer file and all three shims under homeDir', async () => {
  const homeDir = await mkTmp('sm-guard-shims-home-');
  const r = await writeGuardShims({ homeDir });
  expect(r.ok).toBe(true);

  expect(fs.existsSync(pointerPath(homeDir))).toBe(true);
  expect(JSON.parse(fs.readFileSync(pointerPath(homeDir), 'utf8'))).toEqual({ appRoot: APP_ROOT });
  for (const name of GUARD_NAMES) {
    expect(fs.existsSync(shimPath(name, homeDir))).toBe(true);
  }
  expect(guardShimsExist(homeDir)).toBe(true);
});

test('writeGuardShims: does NOT vendor guard logic — the shim body only references the guard by name, never copies its source', async () => {
  const homeDir = await mkTmp('sm-guard-shims-home-');
  await writeGuardShims({ homeDir });

  const realSource = fs.readFileSync(path.join(APP_ROOT, 'scripts', 'hooks', 'guard-prd-writes.cjs'), 'utf8');
  const shimSource = fs.readFileSync(shimPath('guard-prd-writes.cjs', homeDir), 'utf8');
  expect(shimSource).not.toContain('SCHEDULER_SEGMENT'); // a guard-prd-writes-specific symbol
  expect(shimSource.length).toBeLessThan(realSource.length / 2);
  expect(shimSource).toContain("require(path.join(ptr.appRoot, 'scripts', 'hooks', 'guard-prd-writes.cjs'))");
});

test('writeGuardShims: idempotent — re-running with the same appRoot produces byte-identical files', async () => {
  const homeDir = await mkTmp('sm-guard-shims-home-');
  const r1 = await writeGuardShims({ homeDir });
  expect(r1.ok).toBe(true);
  const pointerBefore = fs.readFileSync(pointerPath(homeDir), 'utf8');
  const shimsBefore = GUARD_NAMES.map((n) => fs.readFileSync(shimPath(n, homeDir), 'utf8'));

  const r2 = await writeGuardShims({ homeDir });
  expect(r2.ok).toBe(true);
  expect(fs.readFileSync(pointerPath(homeDir), 'utf8')).toBe(pointerBefore);
  GUARD_NAMES.forEach((n, i) => {
    expect(fs.readFileSync(shimPath(n, homeDir), 'utf8')).toBe(shimsBefore[i]);
  });
});

test('writeGuardShims: the installed shim actually resolves through the pointer and runs the real guard logic', async () => {
  const homeDir = await mkTmp('sm-guard-shims-home-');
  const cwd = await mkTmp('sm-guard-shims-cwd-');
  await writeGuardShims({ homeDir });

  const denied = runGuard(shimPath('guard-prd-writes.cjs', homeDir), {
    toolInput: { file_path: path.join(cwd, 'session-manager-operations', 'scheduler', 'prds', '1234-x.md'), content: '# x' },
    cwd,
  });
  expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');

  const allowed = runGuard(shimPath('guard-prd-writes.cjs', homeDir), {
    toolInput: { file_path: path.join(cwd, 'src', 'x.ts'), content: 'x' },
    cwd,
  });
  expect(allowed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

test('writeGuardShims: rewriting the pointer to a DIFFERENT app root lets an already-installed shim follow an app upgrade with no re-install', async () => {
  const homeDir = await mkTmp('sm-guard-shims-home-');
  const cwd = await mkTmp('sm-guard-shims-cwd-');
  await writeGuardShims({ homeDir }); // "first install", points at the real APP_ROOT
  const shimFile = shimPath('guard-prd-writes.cjs', homeDir);
  const shimBytesBefore = fs.readFileSync(shimFile, 'utf8');

  // Simulate an app upgrade: a second "app root" at a brand-new path, with
  // its own copy of scripts/hooks/guard-prd-writes.cjs — the file guardShims
  // reads through the pointer at invocation time — plus the sibling policy
  // module it `require()`s at load time (guard-prd-writes-policy.cjs, PRD
  // 1415); a real upgrade ships both since both are listed in package.json's
  // "files".
  const secondAppRoot = await mkTmp('sm-guard-shims-upgraded-app-');
  await fsp.mkdir(path.join(secondAppRoot, 'scripts', 'hooks', 'lib'), { recursive: true });
  await fsp.copyFile(
    path.join(APP_ROOT, 'scripts', 'hooks', 'guard-prd-writes.cjs'),
    path.join(secondAppRoot, 'scripts', 'hooks', 'guard-prd-writes.cjs'),
  );
  await fsp.copyFile(
    path.join(APP_ROOT, 'scripts', 'hooks', 'lib', 'guard-prd-writes-policy.cjs'),
    path.join(secondAppRoot, 'scripts', 'hooks', 'lib', 'guard-prd-writes-policy.cjs'),
  );

  const r = await writeGuardShims({ homeDir, appRoot: secondAppRoot });
  expect(r.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(pointerPath(homeDir), 'utf8')).appRoot).toBe(secondAppRoot);
  // The shim FILE at the already-installed path never changed.
  expect(fs.readFileSync(shimFile, 'utf8')).toBe(shimBytesBefore);

  // A project hook that already references this exact shim path keeps working.
  const denied = runGuard(shimFile, {
    toolInput: { file_path: path.join(cwd, 'session-manager-operations', 'scheduler', 'prds', '1234-x.md'), content: '# x' },
    cwd,
  });
  expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
});

test('writeGuardShims: returns { ok:false, error } without throwing when homeDir cannot be written to', async () => {
  const base = await mkTmp('sm-guard-shims-unwritable-');
  const blocker = path.join(base, 'blocker-file');
  await fsp.writeFile(blocker, 'x', 'utf8');
  // A homeDir whose parent path segment is a plain FILE can never be mkdir'd
  // into (ENOTDIR) — reproduces "unwritable ~/.claude" without relying on
  // permission bits, which root would bypass.
  const homeDir = path.join(blocker, 'home');

  const r = await writeGuardShims({ homeDir });
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
  expect(guardShimsExist(homeDir)).toBe(false);
});
