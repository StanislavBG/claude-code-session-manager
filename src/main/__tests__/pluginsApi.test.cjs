import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// config.cjs pins its write allowlist to os.homedir() at load: set HOME first.
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-api-root-'));
process.env.HOME = HOME_ROOT;
const pi = require('../pluginInstall.cjs');
const { schemas } = require('../ipcSchemas.cjs');

let home = HOME_ROOT;
beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'foo@mkt': [{ scope: 'user', version: '1.0.0', installPath: '/x' }], 'bar@mkt': [{ scope: 'user' }] },
  }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'x', enabledPlugins: { 'foo@mkt': true, 'ghost@mkt': true } }));
});
afterEach(() => fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true }));

describe('plugins api', () => {
  it('lists installed joined with enabled', () => {
    const l = pi.listInstalled(home);
    expect(l.map((p) => [p.key, p.enabled])).toEqual([['foo@mkt', true], ['bar@mkt', false]]);
    expect(l[0]).toMatchObject({ name: 'foo', marketplace: 'mkt', version: '1.0.0' });
    expect(pi.isInstalled('foo@mkt', home)).toBe(true);
    expect(pi.isInstalled('ghost@mkt', home)).toBe(false);
  });

  it('set-enabled round-trips via settings.json', async () => {
    expect((await pi.setEnabled({ key: 'bar@mkt', enabled: true, home })).ok).toBe(true);
    expect(pi.listInstalled(home).find((p) => p.key === 'bar@mkt').enabled).toBe(true);
    expect((await pi.setEnabled({ key: 'bar@mkt', enabled: false, home })).ok).toBe(true);
    const st = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    expect(st.enabledPlugins['bar@mkt']).toBe(false);
    expect(st.model).toBe('x');
    expect((await pi.setEnabled({ key: '--bad', enabled: true, home })).ok).toBe(false);
  });

  it('uninstall rejects bad slug and uses the runner', async () => {
    const calls = [];
    const runner = async (o) => { calls.push(o.args); return { ok: true, exitCode: 0 }; };
    expect((await pi.uninstall({ slug: '-rf', marketplaceName: 'mkt', runner })).ok).toBe(false);
    expect(calls).toEqual([]);
    expect(await pi.uninstall({ slug: 'foo', marketplaceName: 'mkt', runner })).toEqual({ ok: true, exitCode: 0 });
    expect(calls).toEqual([['plugin', 'uninstall', 'foo@mkt']]);
  });

  it('schemas are strict', () => {
    expect(schemas.pluginsSetEnabled.safeParse({ key: 'a@b', enabled: true, extra: 1 }).success).toBe(false);
    expect(schemas.pluginsSetEnabled.safeParse({ key: 'a@b', enabled: true }).success).toBe(true);
    expect(schemas.pluginsUninstall.safeParse({ slug: '-x', marketplaceName: 'm' }).success).toBe(false);
  });
});
