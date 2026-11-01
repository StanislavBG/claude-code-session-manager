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
