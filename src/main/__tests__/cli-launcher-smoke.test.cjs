import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..', '..');
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-launcher-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('bin/cli.cjs launcher (real process, fake Electron)', () => {
  it('respawns after an exit-0 run that left the sentinel open, then exits 0 after a clean run', async () => {
    const pkg = path.join(tmp, 'pkg');
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'node_modules', 'electron'), { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    for (const f of fs.readdirSync(path.join(REPO, 'bin'))) {
      if (f.endsWith('.cjs')) fs.copyFileSync(path.join(REPO, 'bin', f), path.join(pkg, 'bin', f));
    }
    fs.mkdirSync(path.join(pkg, 'src', 'main', 'lib', 'process'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'src', 'main', 'lib', 'process', 'ozonePlatform.cjs'), path.join(pkg, 'src', 'main', 'lib', 'process', 'ozonePlatform.cjs'));
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));

    const fake = path.join(tmp, 'fake-electron.sh');
    const counter = path.join(tmp, 'runs');
    fs.writeFileSync(fake, [
      '#!/usr/bin/env bash',
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      'n=$((n+1))',
      `echo $n > "${counter}"`,
      'echo "fake-electron stderr run $n" >&2',
      'if [ "$n" = "1" ]; then open=true; else open=false; fi',
      `echo "{\\"open\\":$open,\\"pid\\":$$}" > "${logs}/last-run.json"`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(pkg, 'node_modules', 'electron', 'index.js'), `module.exports = ${JSON.stringify(fake)};\n`);

    const env = { ...process.env, SM_LOGS_DIR: logs };
    const code = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(pkg, 'bin', 'cli.cjs')], { cwd: pkg, env, stdio: ['ignore', 'ignore', 'ignore'] });
      p.on('error', reject);
      p.on('close', (c) => resolve(c));
    });

    expect(code).toBe(0);
    expect(fs.readFileSync(counter, 'utf8').trim()).toBe('2');
    const exits = fs.readFileSync(path.join(logs, 'main-exit.jsonl'), 'utf8').trim().split('\n');
    expect(exits).toHaveLength(2);
    const err = fs.readFileSync(path.join(logs, 'electron-stderr.log'), 'utf8');
    expect(err).toContain('fake-electron stderr run 1');
    expect(err).toContain('fake-electron stderr run 2');
  }, 15000);

  async function runArgv(envExtra, launcherArgs) {
    const pkg = path.join(tmp, 'pkg');
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'node_modules', 'electron'), { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    for (const f of fs.readdirSync(path.join(REPO, 'bin'))) {
      if (f.endsWith('.cjs')) fs.copyFileSync(path.join(REPO, 'bin', f), path.join(pkg, 'bin', f));
    }
    fs.mkdirSync(path.join(pkg, 'src', 'main', 'lib', 'process'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'src', 'main', 'lib', 'process', 'ozonePlatform.cjs'), path.join(pkg, 'src', 'main', 'lib', 'process', 'ozonePlatform.cjs'));
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));
    const argvFile = path.join(tmp, 'argv.txt');
    const fake = path.join(tmp, 'fake-electron.sh');
    fs.writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(pkg, 'node_modules', 'electron', 'index.js'), `module.exports = ${JSON.stringify(fake)};\n`);
    const env = { ...process.env, SM_LOGS_DIR: logs, ...envExtra };
    for (const k of Object.keys(envExtra)) if (envExtra[k] === undefined) delete env[k];
    await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(pkg, 'bin', 'cli.cjs'), ...launcherArgs], { cwd: pkg, env, stdio: 'ignore' });
      p.on('error', reject);
      p.on('close', resolve);
    });
    return { argv: fs.readFileSync(argvFile, 'utf8').trim().split('\n'), pkg };
  }

  it('passes --ozone-platform=x11 before the app path on Wayland with DISPLAY', async () => {
    const { argv, pkg } = await runArgv({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', SM_OZONE_PLATFORM: undefined }, []);
    const flagAt = argv.indexOf('--ozone-platform=x11');
    expect(flagAt).toBe(0);
    expect(argv.indexOf(fs.realpathSync(pkg))).toBeGreaterThan(flagAt);
  }, 15000);

  it('passes no flag with XDG_SESSION_TYPE and DISPLAY unset', async () => {
    const { argv } = await runArgv({ XDG_SESSION_TYPE: undefined, DISPLAY: undefined, SM_OZONE_PLATFORM: undefined }, []);
    expect(argv.some((a) => a.startsWith('--ozone-platform'))).toBe(false);
  }, 15000);

  it('an explicit --ozone-platform launcher arg wins and is not duplicated', async () => {
    const { argv } = await runArgv({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', SM_OZONE_PLATFORM: undefined }, ['--ozone-platform=wayland']);
    expect(argv.filter((a) => a.startsWith('--ozone-platform'))).toEqual(['--ozone-platform=wayland']);
  }, 15000);
});

// Electron's chrome_crashpad_handler inherits the launcher's stderr pipe as its fd 2 and can
// outlive the main process, so the child's 'close' may never fire. A background `sleep 30`
// started by the fake Electron plays that part.
describe("bin/cli.cjs launcher when a background process keeps Electron's stderr open", () => {
  let launcher = null;
  const bgPids = () => {
    try { return fs.readFileSync(path.join(tmp, 'bg-pids'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
  };
  // Runs before the file-level afterEach removes tmp (and with it the pid file).
  afterEach(() => {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    launcher = null;
    for (const pid of bgPids()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  // The fake counts its runs, writes one stderr line, runs `body` (sets $open; may start the
  // background sleep and append its pid to $pids), writes the sentinel for its own pid, exits 0.
  function stage(body) {
    const pkg = path.join(tmp, 'pkg');
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'node_modules', 'electron'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'src', 'main', 'lib', 'process'), { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    for (const f of fs.readdirSync(path.join(REPO, 'bin'))) {
      if (f.endsWith('.cjs')) fs.copyFileSync(path.join(REPO, 'bin', f), path.join(pkg, 'bin', f));
    }
    fs.copyFileSync(path.join(REPO, 'src', 'main', 'lib', 'process', 'ozonePlatform.cjs'), path.join(pkg, 'src', 'main', 'lib', 'process', 'ozonePlatform.cjs'));
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));
    const fake = path.join(tmp, 'fake-electron.sh');
    fs.writeFileSync(fake, [
      '#!/usr/bin/env bash',
      `counter="${path.join(tmp, 'runs')}"`,
      `pids="${path.join(tmp, 'bg-pids')}"`,
      'n=$(cat "$counter" 2>/dev/null || echo 0)',
      'n=$((n+1))',
      'echo $n > "$counter"',
      'echo "fake-electron stderr run $n" >&2',
      ...body,
      `echo "{\\"open\\":$open,\\"pid\\":$$}" > "${logs}/last-run.json"`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(pkg, 'node_modules', 'electron', 'index.js'), `module.exports = ${JSON.stringify(fake)};\n`);
    return { pkg, logs };
  }

  // Resolves with the launcher's exit; rejects at the deadline (afterEach then kills it).
  function runLauncher({ pkg, logs }, deadlineMs) {
    return new Promise((resolve, reject) => {
      launcher = spawn(process.execPath, [path.join(pkg, 'bin', 'cli.cjs')], { cwd: pkg, env: { ...process.env, SM_LOGS_DIR: logs }, stdio: 'ignore' });
      const timer = setTimeout(() => reject(new Error(`launcher still running ${deadlineMs} ms after start`)), deadlineMs);
      launcher.on('error', (err) => { clearTimeout(timer); reject(err); });
      launcher.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
  }

  const exitRecords = (logs) => fs.readFileSync(path.join(logs, 'main-exit.jsonl'), 'utf8').trim().split('\n');

  it('exits 0 within 10 s after a clean run whose stderr a background process still holds', async () => {
    const staged = stage(['sleep 30 &', 'echo $! >> "$pids"', 'open=false']);
    expect(await runLauncher(staged, 10000)).toEqual({ code: 0, signal: null });
    const held = bgPids();
    expect(held).toHaveLength(1);
    expect(() => process.kill(held[0], 0)).not.toThrow(); // still held the pipe when the launcher exited
    expect(exitRecords(staged.logs)).toHaveLength(1);
    expect(fs.readFileSync(path.join(staged.logs, 'electron-stderr.log'), 'utf8')).toContain('fake-electron stderr run 1');
  }, 20000);

  it('respawns once after an unclean run whose stderr a background process still holds, then exits 0 within 15 s', async () => {
    const staged = stage([
      'if [ "$n" = "1" ]; then',
      '  sleep 30 &',
      '  echo $! >> "$pids"',
      '  open=true',
      'else',
      '  open=false',
      'fi',
    ]);
    expect(await runLauncher(staged, 15000)).toEqual({ code: 0, signal: null });
    expect(fs.readFileSync(path.join(tmp, 'runs'), 'utf8').trim()).toBe('2');
    const held = bgPids();
    expect(held).toHaveLength(1);
    expect(() => process.kill(held[0], 0)).not.toThrow();
    expect(exitRecords(staged.logs)).toHaveLength(2);
    const err = fs.readFileSync(path.join(staged.logs, 'electron-stderr.log'), 'utf8');
    expect(err).toContain('fake-electron stderr run 1');
    expect(err).toContain('fake-electron stderr run 2');
  }, 25000);
});
