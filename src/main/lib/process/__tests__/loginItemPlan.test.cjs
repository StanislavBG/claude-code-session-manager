import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { planLoginItem } = require('../loginItemPlan.cjs');

const HOME = '/home/ann';
const WEIRD = "/Users/o'neil smith";
const APP_ID = 'run.bilko.session-manager';
const NPX = '/usr/local/bin/npx';

function hasSh() {
  try { return spawnSync('sh', ['-c', 'exit 0']).status === 0; } catch { return false; }
}

describe('planLoginItem — not supported', () => {
  it('dev run', () => {
    const p = planLoginItem({ platform: 'linux', packaged: false, dev: true, homeDir: HOME, npxPath: NPX });
    expect(p.supported).toBe(false);
    expect(p.reason).toMatch(/dev/i);
  });
  it('npx install on win32', () => {
    const p = planLoginItem({ platform: 'win32', packaged: false, dev: false, homeDir: 'C:\\Users\\a', npxPath: 'C:\\npx.cmd' });
    expect(p.supported).toBe(false);
    expect(p.reason).toMatch(/windows/i);
  });
  it('packaged Linux build without appImagePath', () => {
    const p = planLoginItem({ platform: 'linux', packaged: true, dev: false, homeDir: HOME });
    expect(p.supported).toBe(false);
    expect(p.reason).toMatch(/AppImage/);
  });
  it('npx install without npxPath', () => {
    for (const platform of ['linux', 'darwin']) {
      const p = planLoginItem({ platform, packaged: false, dev: false, homeDir: HOME, appId: APP_ID });
      expect(p.supported).toBe(false);
      expect(p.reason).toMatch(/npx/);
    }
  });
});

describe('planLoginItem — packaged darwin/win32', () => {
  it('uses the Electron login item and writes no files', () => {
    for (const platform of ['darwin', 'win32']) {
      const p = planLoginItem({ platform, packaged: true, dev: false, homeDir: HOME, appId: APP_ID });
      expect(p).toEqual({ supported: true, mechanism: 'electron-login-item', starts: 'app' });
    }
  });
});

describe('planLoginItem — Linux xdg autostart', () => {
  it('packaged AppImage', () => {
    const p = planLoginItem({ platform: 'linux', packaged: true, dev: false, homeDir: HOME, appImagePath: '/opt/apps/Session Manager.AppImage' });
    expect(p.supported).toBe(true);
    expect(p.mechanism).toBe('xdg-autostart');
    expect(p.starts).toBe('app');
    expect(p.entryPath).toBe('/home/ann/.config/autostart/claude-code-session-manager.desktop');
    const lines = p.entryText.split('\n');
    expect(lines[0]).toBe('[Desktop Entry]');
    expect(lines).toContain('Type=Application');
    expect(lines).toContain('Name=Session Manager');
    expect(lines).toContain('Terminal=false');
    expect(lines).toContain('X-Session-Manager-Login-Item=1');
    expect(lines).toContain('Exec="/opt/apps/Session Manager.AppImage"');
    expect(p.scriptPath).toBeUndefined();
    expect(p.scriptText).toBeUndefined();
  });
  it('escapes " ` $ \\ inside the Exec double quotes', () => {
    const p = planLoginItem({ platform: 'linux', packaged: true, dev: false, homeDir: HOME, appImagePath: '/a/"b`c$d\\e.AppImage' });
    expect(p.entryText).toContain('Exec="/a/\\"b\\`c\\$d\\\\e.AppImage"');
  });
  it('npx install runs the script through /bin/sh', () => {
    const p = planLoginItem({ platform: 'linux', packaged: false, dev: false, homeDir: HOME, npxPath: NPX });
    expect(p.supported).toBe(true);
    expect(p.mechanism).toBe('xdg-autostart');
    expect(p.starts).toBe('npx');
    expect(p.entryPath).toBe('/home/ann/.config/autostart/claude-code-session-manager.desktop');
    expect(p.entryText).toContain('Exec=/bin/sh "/home/ann/.claude/session-manager/start-at-login.sh"');
    expect(p.entryText).toContain('X-Session-Manager-Login-Item=1');
    expect(p.scriptPath).toBe('/home/ann/.claude/session-manager/start-at-login.sh');
    expect(typeof p.scriptText).toBe('string');
  });
  it('quotes a home folder with a space and a single quote', () => {
    const p = planLoginItem({ platform: 'linux', packaged: false, dev: false, homeDir: WEIRD, npxPath: `${WEIRD}/.nvm/bin/npx` });
    expect(p.entryPath).toBe(`${WEIRD}/.config/autostart/claude-code-session-manager.desktop`);
    expect(p.entryText).toContain(`Exec=/bin/sh "${WEIRD}/.claude/session-manager/start-at-login.sh"`);
    expect(p.scriptText).toContain("LOG='/Users/o'\\''neil smith/.claude/session-manager/start-at-login.log'");
    expect(p.scriptText).toContain("NPX='/Users/o'\\''neil smith/.nvm/bin/npx'");
  });
});

describe('planLoginItem — darwin npx launch agent', () => {
  it('writes a property list for the launch agent', () => {
    const p = planLoginItem({ platform: 'darwin', packaged: false, dev: false, homeDir: '/Users/ann', npxPath: NPX, appId: APP_ID });
    expect(p.supported).toBe(true);
    expect(p.mechanism).toBe('launch-agent');
    expect(p.starts).toBe('npx');
    expect(p.entryPath).toBe('/Users/ann/Library/LaunchAgents/run.bilko.session-manager.login.plist');
    const t = p.entryText;
    expect(t).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(t).toContain('<key>Label</key>\n  <string>run.bilko.session-manager.login</string>');
    expect(t).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/bin\/sh<\/string>\s*<string>\/Users\/ann\/\.claude\/session-manager\/start-at-login\.sh<\/string>\s*<\/array>/);
    expect(t).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(t).toMatch(/<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
    expect(p.scriptPath).toBe('/Users/ann/.claude/session-manager/start-at-login.sh');
  });
  it('XML-escapes the paths', () => {
    const home = "/Users/o'neil & <x>";
    const p = planLoginItem({ platform: 'darwin', packaged: false, dev: false, homeDir: home, npxPath: NPX, appId: APP_ID });
    expect(p.entryText).toContain('<string>/Users/o&apos;neil &amp; &lt;x&gt;/.claude/session-manager/start-at-login.sh</string>');
    expect(p.entryPath).toBe(`${home}/Library/LaunchAgents/run.bilko.session-manager.login.plist`);
  });
});

describe('planLoginItem — start-at-login script', () => {
  const plan = planLoginItem({ platform: 'linux', packaged: false, dev: false, homeDir: WEIRD, npxPath: NPX });
  const s = plan.scriptText;

  it('has the parts in order', () => {
    const idx = [
      s.indexOf('Session Manager'),
      s.indexOf("'Start at login'"),
      s.indexOf('LOG='),
      s.indexOf('NPX='),
      s.indexOf('command -v npx'),
      s.indexOf('npx not found'),
      s.indexOf('PATH='),
      s.indexOf('--yes claude-code-session-manager@latest'),
      s.indexOf('-lt 120'),
      s.indexOf('--yes --offline claude-code-session-manager'),
      s.lastIndexOf('exit "$STATUS"'),
    ];
    for (const i of idx) expect(i).toBeGreaterThan(-1);
    for (let k = 1; k < idx.length; k += 1) expect(idx[k]).toBeGreaterThan(idx[k - 1]);
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
    expect(s).toContain('"$SHELL" /bin/bash /bin/zsh');
  });

  it.runIf(hasSh())('passes sh -n', () => {
    for (const p of [plan, planLoginItem({ platform: 'darwin', packaged: false, dev: false, homeDir: '/Users/ann', npxPath: NPX, appId: APP_ID })]) {
      const r = spawnSync('sh', ['-n'], { input: p.scriptText, encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
  });

  it.runIf(hasSh() && process.platform !== 'win32')('runs: retries offline after a fast failure, under a home with a space and a quote', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'login-item-'));
    try {
      const home = path.join(base, "o'neil smith");
      const binDir = path.join(home, 'bin dir');
      fs.mkdirSync(binDir, { recursive: true });
      const fakeNpx = path.join(binDir, 'npx');
      const argsLog = path.join(base, 'args.txt');
      fs.writeFileSync(fakeNpx, [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${argsLog}'`,
        'case "$*" in *--offline*) exit 0 ;; *) exit 3 ;; esac',
        '',
      ].join('\n'), { mode: 0o755 });
      const p = planLoginItem({ platform: 'linux', packaged: false, dev: false, homeDir: home, npxPath: fakeNpx });
      fs.mkdirSync(path.dirname(p.scriptPath), { recursive: true });
      fs.writeFileSync(p.scriptPath, p.scriptText);
      const r = spawnSync('/bin/sh', [p.scriptPath], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(argsLog, 'utf8').trim().split('\n')).toEqual([
        '--yes claude-code-session-manager@latest',
        '--yes --offline claude-code-session-manager',
      ]);
      const log = fs.readFileSync(path.join(home, '.claude/session-manager/start-at-login.log'), 'utf8');
      expect(log).toMatch(/offline/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('SCRIPT_MARKER', () => {
  it('is the first comment line of the start script', () => {
    const { planLoginItem: plan, SCRIPT_MARKER } = require('../loginItemPlan.cjs');
    expect(SCRIPT_MARKER).toBe('# Written by Session Manager to start it at login.');
    const p = plan({ platform: 'linux', packaged: false, dev: false, homeDir: '/h', npxPath: '/usr/bin/npx' });
    expect(p.scriptText.split('\n')[1]).toBe(SCRIPT_MARKER);
  });
});
