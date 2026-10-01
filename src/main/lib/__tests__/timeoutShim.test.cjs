/**
 * timeoutShim.test.cjs — unit tests for the GNU-`timeout`-compatible shim
 * script (timeoutShimScript.cjs) and its installer (timeoutShim.cjs). Uses a
 * temp "home" dir per test so the real ~/.claude is never touched.
 *
 * The script is a require-time-safe CLI (guarded by `require.main === module`,
 * unlike guardShims.cjs's guard scripts), but it still forks a real child and
 * calls process.exit — run it as a child process via spawnSync, same as
 * guardShims.test.cjs runs guard shims, never require() it in-process.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/timeoutShim.test.cjs
 */

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { shimDir, shimPath, ensureTimeoutShim, withTimeoutShimOnPath } = require('../timeoutShim.cjs');

const SCRIPT = path.join(__dirname, '..', 'timeoutShimScript.cjs');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(d);
  return d;
}

function runShim(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('exits 124 when the command outlives DURATION', () => {
  const r = runShim(['0.3', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  expect(r.status).toBe(124);
});

test("passes through the command's own exit code when it finishes before DURATION", () => {
  const r = runShim(['5', process.execPath, '-e', 'process.exit(7)']);
  expect(r.status).toBe(7);
});

test('exits 127 when the command does not exist', () => {
  const r = runShim(['5', '/no/such/sm-timeout-shim-test-binary']);
  expect(r.status).toBe(127);
});

test('exits 125 on a malformed DURATION', () => {
  const r = runShim(['not-a-duration', process.execPath, '-e', '0']);
  expect(r.status).toBe(125);
});

test('-k escalates to KILL (137) when the command ignores the first signal', () => {
  // OPTIONs precede DURATION (`timeout [OPTION] DURATION COMMAND ...`): -k's
  // own duration comes first, then the main duration, then the command.
  const r = runShim(['-k', '0.2', '0.2', process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"]);
  expect(r.status).toBe(137);
});

test('--preserve-status reports 128+signal instead of 124 when the command is killed', () => {
  const r = runShim(['--preserve-status', '0.2', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  expect(r.status).toBe(143); // 128 + SIGTERM(15)
});

test('kills a grandchild too, by signalling the whole process group', () => {
  const dir = mkTmp('sm-timeout-shim-pg-');
  const pidFile = path.join(dir, 'grandchild.pid');
  const grandchildScript = path.join(dir, 'grandchild.cjs');
  const childScript = path.join(dir, 'child.cjs');
  fs.writeFileSync(
    grandchildScript,
    "require('node:fs').writeFileSync(process.argv[2], String(process.pid));\nsetInterval(()=>{},1000);\n",
  );
  fs.writeFileSync(
    childScript,
    "require('node:child_process').spawn(process.execPath, [require('node:path').join(__dirname, 'grandchild.cjs'), process.argv[2]], { stdio: 'ignore' });\nsetInterval(()=>{},1000);\n",
  );

  const r = runShim(['0.4', process.execPath, childScript, pidFile]);
  expect(r.status).toBe(124);

  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  expect(Number.isInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
});

test('ensureTimeoutShim installs the shim pair, is idempotent, and sets the launcher mode to 0755', async () => {
  const homeDir = mkTmp('sm-timeout-shim-home-');

  const r1 = await ensureTimeoutShim({ homeDir, execPath: process.execPath });
  expect(r1.ok).toBe(true);
  expect(r1.changed).toBe(true);
  expect(r1.path).toBe(shimPath(homeDir));
  expect(fs.existsSync(path.join(shimDir(homeDir), 'timeout-shim.cjs'))).toBe(true);
  expect(fs.statSync(shimPath(homeDir)).mode & 0o777).toBe(0o755);

  const r2 = await ensureTimeoutShim({ homeDir, execPath: process.execPath });
  expect(r2.ok).toBe(true);
  expect(r2.changed).toBe(false);
  expect(fs.statSync(shimPath(homeDir)).mode & 0o777).toBe(0o755);
});

test('the installed launcher runs end-to-end', async () => {
  const homeDir = mkTmp('sm-timeout-shim-home-');
  await ensureTimeoutShim({ homeDir, execPath: process.execPath });

  const r = spawnSync(shimPath(homeDir), ['5', process.execPath, '-e', 'process.exit(3)'], { encoding: 'utf8' });
  expect(r.status).toBe(3);
});

test('withTimeoutShimOnPath appends the shim dir once, with no duplicate', () => {
  const homeDir = path.join(os.tmpdir(), 'sm-timeout-shim-fake-home');
  const dir = shimDir(homeDir);
  const base = ['/usr/bin', '/bin'].join(path.delimiter);

  const once = withTimeoutShimOnPath(base, homeDir);
  expect(once.split(path.delimiter)).toEqual([...base.split(path.delimiter), dir]);

  const twice = withTimeoutShimOnPath(once, homeDir);
  expect(twice).toBe(once);
  expect(twice.split(path.delimiter).filter((p) => p === dir)).toHaveLength(1);
});
