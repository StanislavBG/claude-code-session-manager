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
});
