import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoginItem } = require('../loginItem.cjs');

const APP_ID = 'run.bilko.session-manager';
const NPX = '/usr/local/bin/npx';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'login-item-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function fakeApp(initial = false) {
  const calls = [];
  let openAtLogin = initial;
  return {
    calls,
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: (s) => { calls.push(s); openAtLogin = !!s.openAtLogin; },
  };
}

function make(over = {}) {
  return createLoginItem({
    app: fakeApp(),
    platform: 'linux',
    packaged: false,
    dev: false,
    homeDir: home,
    env: {},
    appId: APP_ID,
    resolveNpx: () => NPX,
    ...over,
  });
}

const desktopPath = () => path.join(home, '.config/autostart/claude-code-session-manager.desktop');
const scriptPath = () => path.join(home, '.claude/session-manager/start-at-login.sh');
const plistPath = () => path.join(home, `Library/LaunchAgents/${APP_ID}.login.plist`);

describe('createLoginItem — npx install', () => {
  it('linux: on then off', async () => {
    const li = make();
    expect(li.status()).toMatchObject({ supported: true, enabled: false, mechanism: 'xdg-autostart', starts: 'npx' });

    const on = await li.setEnabled(true);
    expect(on).toMatchObject({ supported: true, enabled: true, entryPath: desktopPath() });
    expect(fs.readFileSync(desktopPath(), 'utf8')).toContain('X-Session-Manager-Login-Item=1');
    expect(fs.statSync(scriptPath()).mode & 0o777).toBe(0o700);
    expect(li.status().enabled).toBe(true);

    const off = await li.setEnabled(false);
    expect(off.enabled).toBe(false);
    expect(fs.existsSync(desktopPath())).toBe(false);
    expect(fs.existsSync(scriptPath())).toBe(false);
    // Removing again: missing files are not an error.
    expect((await li.setEnabled(false)).enabled).toBe(false);
  });

  it('darwin: on then off writes a LaunchAgent', async () => {
    const li = make({ platform: 'darwin' });
    const on = await li.setEnabled(true);
    expect(on).toMatchObject({ enabled: true, mechanism: 'launch-agent', entryPath: plistPath() });
    expect(fs.readFileSync(plistPath(), 'utf8')).toContain(`<string>${APP_ID}.login</string>`);
    expect(fs.statSync(scriptPath()).mode & 0o777).toBe(0o700);

    const off = await li.setEnabled(false);
    expect(off.enabled).toBe(false);
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(fs.existsSync(scriptPath())).toBe(false);
  });

  it('a missing script reads as off', async () => {
    const li = make();
    await li.setEnabled(true);
    fs.rmSync(scriptPath());
    expect(li.status().enabled).toBe(false);
  });
});

describe('createLoginItem — packaged darwin', () => {
  it('uses the app login item settings', async () => {
    const app = fakeApp(false);
    const li = make({ app, platform: 'darwin', packaged: true });
    expect(li.status()).toMatchObject({ supported: true, enabled: false, mechanism: 'electron-login-item', starts: 'app' });
    expect((await li.setEnabled(true)).enabled).toBe(true);
    expect((await li.setEnabled(false)).enabled).toBe(false);
    expect(app.calls).toEqual([{ openAtLogin: true }, { openAtLogin: false }]);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe('createLoginItem — status reads the system', () => {
  it('a hand-disabled desktop entry reads as off', async () => {
    const li = make();
    await li.setEnabled(true);
    const text = fs.readFileSync(desktopPath(), 'utf8');
    fs.writeFileSync(desktopPath(), text.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'));
    expect(li.status().enabled).toBe(false);
    fs.writeFileSync(desktopPath(), `${text}Hidden=true\n`);
    expect(li.status().enabled).toBe(false);
    fs.writeFileSync(desktopPath(), text);
    expect(li.status().enabled).toBe(true);
  });
});

describe('createLoginItem — unsupported plan', () => {
  it('status says why and setEnabled throws the reason', async () => {
    const li = make({ dev: true });
    const s = li.status();
    expect(s.supported).toBe(false);
    expect(s.enabled).toBe(false);
    expect(typeof s.reason).toBe('string');
    await expect(li.setEnabled(true)).rejects.toThrow(s.reason);
  });

  it('npx not found', async () => {
    const li = make({ resolveNpx: () => null });
    expect(li.status().supported).toBe(false);
    await expect(li.setEnabled(true)).rejects.toThrow(/npx was not found/);
  });
});

describe('createLoginItem — foreign file at the entry path', () => {
  it('is never overwritten or removed', async () => {
    const foreign = '[Desktop Entry]\nType=Application\nName=Someone else\nExec=/bin/true\n';
    fs.mkdirSync(path.dirname(desktopPath()), { recursive: true });
    fs.writeFileSync(desktopPath(), foreign);
    const li = make();
    expect(li.status().enabled).toBe(false);
    await expect(li.setEnabled(false)).rejects.toThrow(desktopPath());
    await expect(li.setEnabled(true)).rejects.toThrow(desktopPath());
    expect(fs.readFileSync(desktopPath(), 'utf8')).toBe(foreign);
    expect(fs.existsSync(scriptPath())).toBe(false);
  });
});
