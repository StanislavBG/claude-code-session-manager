/**
 * mcpCheckServerIpc.test.cjs — IPC mcp:check-server. The request only NAMES a
 * configured server ({ source, name, cwd?, pluginKey? }, schemas.mcpCheckServer).
 * Main reads that server's config from disk itself (user: ~/.claude.json,
 * project: <cwd>/.mcp.json, plugin: the installed plugin's own files) and hands
 * it to checkMcpServer, whose result comes back unchanged. A server that isn't
 * configured fails as "server not found" without anything being spawned.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/mcpCheckServerIpc.test.cjs
 */

'use strict';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { schemas, validated } = require('../ipcSchemas.cjs');
const { checkConfiguredMcpServer, resolveMcpServerConfig } = require('../lib/mcpToolsProbe.cjs');

// A minimal stdio MCP server: answers initialize, and tools/list with one tool
// named argv[2]. String.raw keeps the escapes intact.
const FIXTURE_SERVER = String.raw`'use strict';
const toolName = process.argv[2];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } });
    else if (msg.method === 'tools/list') reply({ tools: [{ name: toolName, description: 'fixture tool', inputSchema: { type: 'object' } }] });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const NOT_FOUND = { ok: false, status: 'failed', error: 'server not found', checkedAt: expect.any(Number) };

let tmp;
let home;
let project;
/** @type {Record<string, string>} plugin install dirs by plugin name */
const plugins = {};

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** A checkMcpServer stand-in that records its calls and returns one fixed result object. */
function stubCheck() {
  const result = { ok: true, status: 'connected', tools: [{ name: 'stubbed', description: '' }], checkedAt: 1 };
  /** @type {{ server: any, options: any }[]} */
  const calls = [];
  const check = async (server, options) => {
    calls.push({ server, options });
    return result;
  };
  return { check, calls, result };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mcp-check-ipc-'));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  for (const name of ['demo', 'bare', 'declared', 'inline']) {
    plugins[name] = path.join(home, '.claude', 'plugins', 'cache', 'market', name, '1.0.0');
  }

  writeJson(path.join(home, '.claude.json'), {
    numStartups: 3,
    mcpServers: {
      alpha: { command: 'alpha-server', args: ['--stdio'], env: { ALPHA_TOKEN: 'user-secret' } },
      shared: { type: 'http', url: 'https://user.example/mcp' },
      broken: 'not-an-object',
    },
    // Local-scope servers (projects[cwd].mcpServers) are neither user nor project servers.
    projects: { [project]: { mcpServers: { localOnly: { command: 'local-server' } } } },
  });

  writeJson(path.join(project, '.mcp.json'), {
    mcpServers: {
      beta: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer project-token' } },
      shared: { command: 'project-shared' },
      relative: { command: process.execPath, args: ['fixture-server.cjs', 'project-tool'] },
    },
  });
  fs.writeFileSync(path.join(project, 'fixture-server.cjs'), FIXTURE_SERVER);

  writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'demo@market': [{ scope: 'user', installPath: plugins.demo, version: '1.0.0' }],
      'bare@market': [{ scope: 'user', installPath: plugins.bare, version: '1.0.0' }],
      'declared@market': [{ scope: 'user', installPath: plugins.declared, version: '1.0.0' }],
      'inline@market': [{ scope: 'user', installPath: plugins.inline, version: '1.0.0' }],
      'pathless@market': [{ scope: 'user', version: '1.0.0' }],
    },
  });
  // demo: the documented `{ mcpServers }` .mcp.json, paths through ${CLAUDE_PLUGIN_ROOT}.
  writeJson(path.join(plugins.demo, '.mcp.json'), {
    mcpServers: {
      gamma: {
        command: '${CLAUDE_PLUGIN_ROOT}/bin/gamma',
        args: ['--config', '${CLAUDE_PLUGIN_ROOT}/gamma.json'],
        env: { GAMMA_HOME: '${CLAUDE_PLUGIN_ROOT}/data', GAMMA_MODE: 'fast' },
      },
      runnable: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/fixture-server.cjs', 'plugin-tool'] },
    },
  });
  fs.writeFileSync(path.join(plugins.demo, 'fixture-server.cjs'), FIXTURE_SERVER);
  // bare: a .mcp.json that is the server map itself.
  writeJson(path.join(plugins.bare, '.mcp.json'), { delta: { command: 'delta-server' } });
  // declared: the manifest names its server files; one escapes the plugin root and is ignored.
  writeJson(path.join(plugins.declared, '.claude-plugin', 'plugin.json'), {
    name: 'declared',
    mcpServers: ['./config/servers.json', '../../../escape.json'],
  });
  writeJson(path.join(plugins.declared, 'config', 'servers.json'), { mcpServers: { epsilon: { command: 'epsilon-declared' } } });
  writeJson(path.join(plugins.declared, '.mcp.json'), {
    mcpServers: { epsilon: { command: 'epsilon-shadowed' }, zeta: { command: 'zeta-default' } },
  });
  writeJson(path.join(plugins.declared, '..', '..', '..', 'escape.json'), { mcpServers: { escaped: { command: 'outside' } } });
  // inline: a legacy root plugin.json declaring its servers inline.
  writeJson(path.join(plugins.inline, 'plugin.json'), {
    name: 'inline',
    mcpServers: { eta: { type: 'http', url: 'https://inline.example/mcp' } },
  });
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('schemas.mcpCheckServer', () => {
  test('accepts a user, project or plugin request', () => {
    for (const ok of [
      { source: 'user', name: 'alpha' },
      { source: 'user', name: 'a'.repeat(128) },
      { source: 'project', name: 'beta', cwd: '/abs/project' },
      { source: 'plugin', name: 'gamma', pluginKey: 'demo@market' },
      { source: 'user', name: 'alpha', cwd: '/abs/project' },
    ]) {
      expect(schemas.mcpCheckServer.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
  });

  test('rejects anything else', () => {
    for (const bad of [
      undefined,
      null,
      'alpha',
      {},
      { name: 'alpha' },
      { source: 'local', name: 'alpha' },
      { source: 'user' },
      { source: 'user', name: '' },
      { source: 'user', name: 'a'.repeat(129) },
      { source: 'user', name: 42 },
      { source: 'project', name: 'beta' },
      { source: 'project', name: 'beta', cwd: 'relative/project' },
      { source: 'project', name: 'beta', cwd: '' },
      { source: 'project', name: 'beta', cwd: `/${'x'.repeat(4096)}` },
      { source: 'plugin', name: 'gamma' },
      { source: 'plugin', name: 'gamma', pluginKey: 'no-marketplace' },
      { source: 'plugin', name: 'gamma', pluginKey: '../evil@market' },
      // The payload can never carry the config to run.
      { source: 'user', name: 'alpha', command: 'rm', args: ['-rf', '/'] },
      { source: 'user', name: 'alpha', server: { command: 'rm' } },
    ]) {
      expect(schemas.mcpCheckServer.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test('the validated() wrapper throws before the handler runs', () => {
    let ran = 0;
    const handler = validated(schemas.mcpCheckServer, () => { ran += 1; });
    expect(() => handler({}, { source: 'user', name: 'alpha', command: 'rm' })).toThrow();
    expect(() => handler({}, { source: 'project', name: 'beta' })).toThrow();
    expect(ran).toBe(0);
    handler({}, { source: 'user', name: 'alpha' });
    expect(ran).toBe(1);
  });
});

describe('resolution (checkMcpServer stubbed)', () => {
  test('user: mcpServers[name] from ~/.claude.json, started in the home directory; the result comes back unchanged', async () => {
    const { check, calls, result } = stubCheck();
    const res = await checkConfiguredMcpServer({ source: 'user', name: 'alpha' }, { home, check, clientVersion: '9.9.9' });
    expect(res).toBe(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].server).toEqual({ command: 'alpha-server', args: ['--stdio'], env: { ALPHA_TOKEN: 'user-secret' } });
    expect(calls[0].options).toMatchObject({ cwd: home, clientVersion: '9.9.9' });
  });

  test('user: the request cwd does not move a user server', async () => {
    const { check, calls } = stubCheck();
    await checkConfiguredMcpServer({ source: 'user', name: 'alpha', cwd: project }, { home, check });
    expect(calls[0].options.cwd).toBe(home);
  });

  test('project: <cwd>/.mcp.json mcpServers[name], started in the project root', async () => {
    const { check, calls, result } = stubCheck();
    const res = await checkConfiguredMcpServer({ source: 'project', name: 'beta', cwd: project }, { home, check });
    expect(res).toBe(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].server).toEqual({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer project-token' } });
    expect(calls[0].options.cwd).toBe(project);
  });

  test('a source sees only its own servers', async () => {
    const user = await resolveMcpServerConfig({ source: 'user', name: 'shared' }, { home });
    const proj = await resolveMcpServerConfig({ source: 'project', name: 'shared', cwd: project }, { home });
    expect(user && user.server).toEqual({ type: 'http', url: 'https://user.example/mcp' });
    expect(proj && proj.server).toEqual({ command: 'project-shared' });
  });

  test("plugin: the installed plugin's .mcp.json mcpServers[name], ${CLAUDE_PLUGIN_ROOT} expanded", async () => {
    const { check, calls, result } = stubCheck();
    const res = await checkConfiguredMcpServer({ source: 'plugin', name: 'gamma', pluginKey: 'demo@market' }, { home, check });
    expect(res).toBe(result);
    expect(calls).toHaveLength(1);
    const root = plugins.demo;
    expect(calls[0].server).toEqual({
      command: `${root}/bin/gamma`,
      args: ['--config', `${root}/gamma.json`],
      env: { GAMMA_HOME: `${root}/data`, GAMMA_MODE: 'fast' },
    });
    expect(calls[0].options.cwd).toBe(home);
  });

  test('plugin: bare-map .mcp.json, manifest-declared files and inline manifest servers are found the way the Plugins tab lists them', async () => {
    const cases = [
      ['bare@market', 'delta', { command: 'delta-server' }],
      // The declared file comes before the default .mcp.json: the first definition wins.
      ['declared@market', 'epsilon', { command: 'epsilon-declared' }],
      ['declared@market', 'zeta', { command: 'zeta-default' }],
      ['inline@market', 'eta', { type: 'http', url: 'https://inline.example/mcp' }],
    ];
    for (const [pluginKey, name, server] of cases) {
      const found = await resolveMcpServerConfig({ source: 'plugin', name, pluginKey }, { home });
      expect(found && found.server, `${pluginKey} ${name}`).toEqual(server);
    }
  });

  test('a server that is not configured fails as "server not found" without spawning', async () => {
    const requests = [
      { source: 'user', name: 'nope' },
      { source: 'user', name: 'broken' }, // configured, but not an object
      { source: 'user', name: 'localOnly' }, // local scope, not user scope
      { source: 'user', name: '__proto__' },
      { source: 'user', name: 'constructor' },
      { source: 'user', name: 'toString' },
      { source: 'project', name: 'nope', cwd: project },
      { source: 'project', name: 'alpha', cwd: project }, // a user server
      { source: 'project', name: 'localOnly', cwd: project },
      { source: 'project', name: 'beta', cwd: path.join(tmp, 'no-such-project') },
      { source: 'plugin', name: 'gamma', pluginKey: 'missing@market' },
      { source: 'plugin', name: 'nope', pluginKey: 'demo@market' },
      { source: 'plugin', name: 'delta', pluginKey: 'demo@market' }, // another plugin's server
      { source: 'plugin', name: 'escaped', pluginKey: 'declared@market' }, // declared outside the plugin root
      { source: 'plugin', name: 'gamma', pluginKey: 'pathless@market' },
    ];
    for (const request of requests) {
      const { check, calls } = stubCheck();
      const res = await checkConfiguredMcpServer(request, { home, check });
      expect(res, JSON.stringify(request)).toEqual(NOT_FOUND);
      expect(calls, JSON.stringify(request)).toHaveLength(0);
    }
  });

  test('a config file that is not JSON rejects, naming the file, without spawning', async () => {
    const brokenHome = path.join(tmp, 'broken-home');
    fs.mkdirSync(brokenHome, { recursive: true });
    fs.writeFileSync(path.join(brokenHome, '.claude.json'), '{ "mcpServers": ');
    const { check, calls } = stubCheck();
    await expect(checkConfiguredMcpServer({ source: 'user', name: 'alpha' }, { home: brokenHome, check }))
      .rejects.toThrow(/\.claude\.json is not valid JSON/);
    expect(calls).toHaveLength(0);
  });

  test("index.cjs's handler shape: a validated request goes straight through", async () => {
    const { check, calls, result } = stubCheck();
    const handler = validated(schemas.mcpCheckServer, (p) => checkConfiguredMcpServer(p, { home, check }));
    expect(await handler({}, { source: 'project', name: 'beta', cwd: project })).toBe(result);
    expect(await handler({}, { source: 'plugin', name: 'nope', pluginKey: 'demo@market' })).toEqual(NOT_FOUND);
    expect(calls).toHaveLength(1);
  });
});

describe('end to end (the real checkMcpServer)', () => {
  test('a project server with relative args starts in its project root', async () => {
    const res = await checkConfiguredMcpServer({ source: 'project', name: 'relative', cwd: project }, { home, timeoutMs: 10_000 });
    expect(res).toMatchObject({ ok: true, status: 'connected' });
    expect(res.ok && res.tools.map((t) => t.name)).toEqual(['project-tool']);
  }, 20_000);

  test('a plugin server reached through ${CLAUDE_PLUGIN_ROOT} connects', async () => {
    const res = await checkConfiguredMcpServer({ source: 'plugin', name: 'runnable', pluginKey: 'demo@market' }, { home, timeoutMs: 10_000 });
    expect(res).toMatchObject({ ok: true, status: 'connected' });
    expect(res.ok && res.tools.map((t) => t.name)).toEqual(['plugin-tool']);
  }, 20_000);
});
