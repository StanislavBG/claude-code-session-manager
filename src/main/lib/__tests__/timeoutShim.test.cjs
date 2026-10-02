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

test('-s 99 (not a real signal number) is a usage error, exit 125', () => {
  const r = runShim(['-s', '99', '5', process.execPath, '-e', '0']);
  expect(r.status).toBe(125);
  expect(r.stderr).toMatch(/invalid signal '99'/);
});

test('--signal= with an empty value is a usage error, exit 125 (not a silent default)', () => {
  const r = runShim(['--signal=', '5', process.execPath, '-e', '0']);
  expect(r.status).toBe(125);
  expect(r.stderr).toMatch(/invalid signal/);
});

test.each(['KILL', '9', 'sigterm'])(
  '-s %s is accepted (the command finishes before DURATION, so no usage error)',
  (sig) => {
    const r = runShim(['-s', sig, '5', process.execPath, '-e', 'process.exit(0)']);
    expect(r.status).toBe(0);
  },
);

test('-k 0 means no kill-after at all — a command that ignores the main signal and exits on its own is not killed early', () => {
  // DURATION (0.1s) elapses well before the command's own 200ms exit, so the
  // main signal (default TERM) is sent; the command ignores it. With the
  // bug, -k 0 would arm a kill-after timer with a 0ms delay, which fires
  // immediately and SIGKILLs the command. --preserve-status surfaces the
  // command's REAL exit status (0) instead of the usual 124-on-timeout, so a
  // premature kill is visible as 137 instead of being masked by 124 either way.
  const r = runShim([
    '--preserve-status', '-k', '0', '0.1', process.execPath,
    '-e', "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),200);",
  ]);
  expect(r.status).toBe(0);
}, 10000);

test('a DURATION above the setTimeout int32 cap (e.g. 30d) does not fire immediately', () => {
  // Old bug: Node clamps an out-of-range setTimeout delay to ~1ms, so
  // `timeout 30d cmd` killed `cmd` almost instantly instead of waiting.
  const r = runShim(['30d', process.execPath, '-e', 'setTimeout(()=>{},200)']);
  expect(r.status).toBe(0);
}, 10000);

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

test('the written launcher falls back to running the script as Node under Electron (ELECTRON_RUN_AS_NODE=1) when no node is on PATH', async () => {
  const homeDir = mkTmp('sm-timeout-shim-home-');
  const fakeElectronPath = '/Applications/Fake Electron.app/Contents/MacOS/Electron';
  await ensureTimeoutShim({ homeDir, execPath: fakeElectronPath });

  const launcherText = fs.readFileSync(shimPath(homeDir), 'utf8');
  expect(launcherText).toMatch(/command -v node/);
  expect(launcherText).toContain('ELECTRON_RUN_AS_NODE=1');
  // execPath is single-quoted for POSIX sh, so a space in the path (as in a
  // real "*.app/Contents/MacOS/Electron" path) stays one argument.
  expect(launcherText).toContain(`'${fakeElectronPath}'`);
});

test('the installed launcher runs end-to-end when homeDir and execPath both contain a space, and no node is on PATH', async () => {
  const homeDir = mkTmp('sm timeout shim home-');
  const execDir = mkTmp('a b-');
  const spacedExecPath = path.join(execDir, 'node');
  fs.symlinkSync(process.execPath, spacedExecPath);
  await ensureTimeoutShim({ homeDir, execPath: spacedExecPath });

  // Standard-utils-only PATH: the launcher script itself still needs
  // `dirname`/`command` (not shell builtins on every /bin/sh), but neither
  // stock directory ships a `node` binary, so `command -v node` fails and
  // the launcher takes the quoted-execPath fallback branch instead of the
  // plain `exec node ...` one. Same PATH the withTimeoutShimOnPath test
  // below uses.
  const env = { ...process.env, PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
  const launcher = shimPath(homeDir);

  const r1 = spawnSync(launcher, ['5', spacedExecPath, '-e', 'process.exit(3)'], { encoding: 'utf8', env });
  expect(r1.status).toBe(3);

  const r2 = spawnSync(launcher, ['1', spacedExecPath, '-e', 'setTimeout(()=>{},5000)'], { encoding: 'utf8', env });
  expect(r2.status).toBe(124);
}, 15000);

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
