'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveHeadlessMcpServers } = require('../headlessMcpServers.cjs');
const seed = require('../../../seedSchedulerMcp.cjs');

let home;
let cwd;
const write = (file, obj) => fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
const userFile = () => path.join(home, '.claude.json');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-cwd-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('resolveHeadlessMcpServers', () => {
  it('resolves a user-only server', () => {
    write(userFile(), { mcpServers: { 'bilko-host': { command: 'a' } } });
    const { known } = resolveHeadlessMcpServers({ cwd, home });
    expect(known['bilko-host']).toEqual({ command: 'a' });
  });

  it('project overrides user; local overrides project', () => {
    write(userFile(), {
      mcpServers: { x: { command: 'user' }, y: { command: 'user' } },
      projects: { [cwd]: { mcpServers: { x: { command: 'local' } } } },
    });
    write(path.join(cwd, '.mcp.json'), { mcpServers: { x: { command: 'proj' }, y: { command: 'proj' } } });
    const { known } = resolveHeadlessMcpServers({ cwd, home });
    expect(known.x.command).toBe('local');
    expect(known.y.command).toBe('proj');
  });

  it('scheduler entry wins over a config entry of the same name', () => {
    write(userFile(), { mcpServers: { [seed.SERVER_NAME]: { command: 'evil' } } });
    const { known } = resolveHeadlessMcpServers({ cwd, home });
    expect(known[seed.SERVER_NAME]).toEqual(seed.schedulerServerEntry());
  });

  it('excludes and names credentialed env keys and Authorization headers', () => {
    write(userFile(), {
      mcpServers: {
        a: { command: 'a', env: { GITHUB_TOKEN: 'sekret-1' } },
        b: { url: 'https://b', headers: { Authorization: 'Bearer sekret-2' } },
        c: { command: 'c', env: { FOO: 'ok' } },
      },
    });
    const { known, credentialed } = resolveHeadlessMcpServers({ cwd, home });
    expect(known.a).toBeUndefined();
    expect(known.b).toBeUndefined();
    expect(known.c).toBeDefined();
    expect(credentialed.a).toContain('GITHUB_TOKEN');
    expect(credentialed.b).toContain('Authorization');
    expect(JSON.stringify(credentialed)).not.toMatch(/sekret/);
  });

  it('missing and malformed files yield only the scheduler entry', () => {
    expect(Object.keys(resolveHeadlessMcpServers({ cwd, home }).known)).toEqual([seed.SERVER_NAME]);
    write(userFile(), '{not json');
    write(path.join(cwd, '.mcp.json'), '[[');
    const r = resolveHeadlessMcpServers({ cwd, home });
    expect(Object.keys(r.known)).toEqual([seed.SERVER_NAME]);
    expect(r.credentialed).toEqual({});
  });

  it('a non-absolute cwd skips project and local scopes', () => {
    write(userFile(), { mcpServers: { u: { command: 'u' } }, projects: { rel: { mcpServers: { l: { command: 'l' } } } } });
    const r = resolveHeadlessMcpServers({ cwd: 'rel', home });
    expect(Object.keys(r.known).sort()).toEqual([seed.SERVER_NAME, 'u'].sort());
  });

  const refused = (entry, ...needles) => {
    write(userFile(), { mcpServers: { s: entry } });
    const { known, credentialed } = resolveHeadlessMcpServers({ cwd, home });
    expect(known.s).toBeUndefined();
    expect(credentialed.s).toContain('s ');
    for (const n of needles) expect(credentialed.s).toContain(n);
    expect(credentialed.s).not.toMatch(/sekret/);
    return credentialed.s;
  };

  it('refuses a secret flag followed by a value', () => {
    expect(refused({ command: 'x', args: ['--API-Key', 'sekret'] }, '--api-key', 'args')).toContain('s ');
  });
  it('refuses a secret flag in --flag=value form', () => {
    expect(refused({ command: 'x', args: ['--token=sekret'] }, '--token', 'args')).toContain('s ');
  });
  it('refuses URL userinfo in args', () => {
    expect(refused({ command: 'x', args: ['https://u:sekret@host/p'] }, 'userinfo', 'args')).toContain('s ');
  });
  it('refuses URL userinfo in url', () => {
    expect(refused({ url: 'https://u:sekret@host/p' }, 'userinfo', 'url')).toContain('s ');
  });
  it('refuses a credential query key in url', () => {
    expect(refused({ url: 'https://host/p?access_token=sekret' }, 'access_token', 'url')).toContain('s ');
  });
  it('refuses broader env and header key names', () => {
    expect(refused({ command: 'x', env: { GITHUB_PAT: 'sekret' } }, 'GITHUB_PAT', 'env')).toContain('s ');
    expect(refused({ command: 'x', env: { AWS_CREDENTIALS: 'sekret' } }, 'AWS_CREDENTIALS')).toContain('s ');
    expect(refused({ command: 'x', env: { MY_PRIVATE_KEY: 'sekret' } }, 'MY_PRIVATE_KEY')).toContain('s ');
    expect(refused({ url: 'https://h', headers: { 'X-Authorization-Extra': 'sekret' } }, 'X-Authorization-Extra', 'headers')).toContain('s ');
  });
  it('refuses URL userinfo in an env value', () => {
    expect(refused({ command: 'x', env: { DB: 'postgres://u:sekret@h/db' } }, 'DB', 'userinfo')).toContain('s ');
  });

  it('real-config shapes still resolve as known', () => {
    write(userFile(), {
      mcpServers: {
        plain: { command: 'npx', args: ['-y', 'some-mcp@latest', '--port', '8080'] },
        blender: { command: 'uvx', args: ['blender-mcp'], env: { BLENDER_MCP_HOST: 'localhost', BLENDER_MCP_PORT: '9876', BLENDER_MCP_PATH: '/usr/bin/blender' } },
        remote: { url: 'https://host/mcp?mode=fast' },
      },
    });
    const { known, credentialed } = resolveHeadlessMcpServers({ cwd, home });
    expect(Object.keys(credentialed)).toEqual([]);
    expect(Object.keys(known)).toEqual(expect.arrayContaining(['plain', 'blender', 'remote']));
  });

  it('projectRoot local scope merges before cwd (cwd wins)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-root-'));
    try {
      write(userFile(), {
        projects: {
          [root]: { mcpServers: { a: { command: 'root' }, b: { command: 'root' } } },
          [cwd]: { mcpServers: { b: { command: 'cwd' } } },
        },
      });
      const { known } = resolveHeadlessMcpServers({ cwd, projectRoot: root, home });
      expect(known.a.command).toBe('root');
      expect(known.b.command).toBe('cwd');
      expect(resolveHeadlessMcpServers({ cwd, home }).known.a).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
