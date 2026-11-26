'use strict';

const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
import { describe, it, expect } from 'vitest';

const { runServiceCli, pairLocal, CONFIRM_HINT, REVOKED_MSG } = require('../serviceStdioBridge.cjs');

function sink() {
  const s = new PassThrough();
  let text = '';
  s.on('data', (c) => { text += c.toString('utf8'); });
  return { stream: s, get text() { return text; } };
}

/** Fake serviceClient: records calls; behavior overridable per test. */
function fakeClient(over = {}) {
  const calls = [];
  const client = {
    calls,
    state: 'paired',
    opts: null,
    async pair(args) { calls.push(['pair', args]); if (over.pair) return over.pair(args); return { clientId: 'c1', deviceId: 'dev-1' }; },
    async connect() {
      calls.push(['connect']);
      if (over.connect) return over.connect(client);
      if (client.opts && client.opts.onSas) client.opts.onSas('1234 5678');
      client.state = 'ready';
      return { sas: '1234 5678' };
    },
    async listTools() { calls.push(['listTools']); if (over.listTools) return over.listTools(client); return [{ name: 'epic_get', inputSchema: {} }]; },
    async callTool(name, args) { calls.push(['callTool', name, args]); if (over.callTool) return over.callTool(name, args, client); return { content: [{ type: 'text', text: `ok ${name}` }] }; },
    close() { calls.push(['close']); if (client.state !== 'revoked') client.state = 'closed'; },
  };
  const factory = (opts) => { client.opts = opts; return client; };
  return { client, factory };
}

function startMcp(over) {
  const { client, factory } = fakeClient(over);
  const stdin = new PassThrough();
  const out = sink();
  const err = sink();
  const done = runServiceCli(['mcp', '--state-dir', '/tmp/svc-state'], { stdin, stdout: out.stream, stderr: err.stream, clientFactory: factory });
  const responses = () => out.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  async function request(msg) {
    const before = responses().length;
    stdin.write(`${JSON.stringify(msg)}\n`);
    for (let i = 0; i < 200 && responses().length === before; i += 1) await new Promise((r) => setTimeout(r, 5));
    return responses()[before];
  }
  return { client, stdin, out, err, done, request, responses };
}

describe('serviceStdioBridge CLI routing', () => {
  it('no or unknown subcommand prints usage and exits 2', async () => {
    const e1 = sink();
    expect(await runServiceCli([], { stderr: e1.stream, stdout: sink().stream })).toBe(2);
    expect(e1.text).toMatch(/usage:/);
    const e2 = sink();
    expect(await runServiceCli(['frob'], { stderr: e2.stream, stdout: sink().stream })).toBe(2);
    expect(e2.text).toMatch(/unknown service subcommand: frob/);
  });

  it('bin/cli.cjs routes service before requiring electron; the bridge never requires electron', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-noelectron-'));
    try {
      const preloadPath = path.join(dir, 'no-electron.cjs');
      fs.writeFileSync(preloadPath, [
        "const Module = require('node:module');",
        'const orig = Module._load;',
        'Module._load = function (req, ...rest) {',
        "  if (req === 'electron') throw new Error('ELECTRON_REQUIRED');",
        '  return orig.call(this, req, ...rest);',
        '};',
        '',
      ].join('\n'));
      const cliPath = path.join(__dirname, '../../../../../bin/cli.cjs');
      const res = spawnSync(process.execPath, ['-r', preloadPath, cliPath, 'service'], { encoding: 'utf8', timeout: 20000 });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/usage:/);
      expect(res.stderr).not.toContain('ELECTRON_REQUIRED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('service pair', () => {
  it('passes --device through, prints SAS + confirm hint, exits 0 on confirm', async () => {
    const { client, factory } = fakeClient();
    const out = sink();
    const code = await runServiceCli(
      ['pair', '--code', 'ABC123', '--name', 'Kiln', '--state-dir', '/tmp/s', '--device', 'aaaaaaaa'],
      { stdout: out.stream, stderr: sink().stream, clientFactory: factory },
    );
    expect(code).toBe(0);
    expect(client.opts.stateDir).toBe('/tmp/s');
    expect(client.calls[0]).toEqual(['pair', { code: 'ABC123', name: 'Kiln', device: 'aaaaaaaa' }]);
    expect(out.text).toContain('SAS: 1234 5678');
    expect(out.text).toContain(CONFIRM_HINT);
    expect(out.text.match(/SAS:/g)).toHaveLength(1);
  });

  it('omits device when --device is absent', async () => {
    const { client, factory } = fakeClient();
    await runServiceCli(['pair', '--code', 'X', '--name', 'Kiln', '--state-dir', '/tmp/s'], { stdout: sink().stream, stderr: sink().stream, clientFactory: factory });
    expect(client.calls[0]).toEqual(['pair', { code: 'X', name: 'Kiln' }]);
  });

  it('bad code and ambiguous device exit non-zero with the message', async () => {
    for (const msg of ['pair failed: invalid or expired code', "device 'aaaaaa' matches 2 devices"]) {
      const { factory } = fakeClient({ pair: () => { throw new Error(msg); } });
      const err = sink();
      const code = await runServiceCli(['pair', '--code', 'X', '--name', 'K', '--state-dir', '/tmp/s'], { stdout: sink().stream, stderr: err.stream, clientFactory: factory });
      expect(code).not.toBe(0);
      expect(err.text).toContain(msg);
    }
  });

  it('revocation while waiting exits non-zero with revoked', async () => {
    const { factory } = fakeClient({ connect: (c) => { c.state = 'revoked'; const e = new Error('service client revoked'); e.code = 'revoked'; throw e; } });
    const err = sink();
    const code = await runServiceCli(['pair', '--code', 'X', '--name', 'K', '--state-dir', '/tmp/s'], { stdout: sink().stream, stderr: err.stream, clientFactory: factory });
    expect(code).not.toBe(0);
    expect(err.text).toContain(REVOKED_MSG);
  });

  it('times out when the desktop never confirms', async () => {
    const { client, factory } = fakeClient({ connect: (c) => { c.opts.onSas('9999 0000'); return new Promise(() => {}); } });
    const out = sink();
    const err = sink();
    const code = await runServiceCli(['pair', '--code', 'X', '--name', 'K', '--state-dir', '/tmp/s', '--timeout', '0.05'], { stdout: out.stream, stderr: err.stream, clientFactory: factory });
    expect(code).not.toBe(0);
    expect(out.text).toContain('SAS: 9999 0000');
    expect(err.text).toMatch(/timed out after 0.05 s/);
    expect(client.calls.at(-1)).toEqual(['close']);
  });

  it('missing required flag is a usage error', async () => {
    const { factory } = fakeClient();
    expect(await runServiceCli(['pair', '--name', 'K', '--state-dir', '/tmp/s'], { stdout: sink().stream, stderr: sink().stream, clientFactory: factory })).toBe(2);
  });
});

describe('service mcp', () => {
  it('initialize, tools/list and tools/call go through the client; stdout is protocol only; stdin close exits 0', async () => {
    const m = startMcp();
    const init = await m.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    expect(m.client.calls.some((c) => c[0] === 'connect')).toBe(true);

    m.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await m.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'epic_get', inputSchema: {} }] } });

    const call = await m.request({ jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'epic_get', arguments: { id: 'e1' } } });
    expect(call).toEqual({ jsonrpc: '2.0', id: 'c', result: { content: [{ type: 'text', text: 'ok epic_get' }] } });
    expect(m.client.calls).toContainEqual(['callTool', 'epic_get', { id: 'e1' }]);

    // every stdout line is a JSON-RPC response (notification was not answered); logs went to stderr
    expect(m.responses().map((r) => r.id)).toEqual([1, 2, 'c']);
    expect(m.err.text).toMatch(/connected/);

    m.stdin.end();
    expect(await m.done).toBe(0);
  });

  it('a remote error keeps its JSON-RPC code; unknown method is -32601; bad JSON is a parse error', async () => {
    const m = startMcp({ callTool: () => { const e = new Error('refused: x is not a tool this service may call'); e.code = 'mcp_error'; e.rpcCode = -32001; throw e; } });
    const r = await m.request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x', arguments: {} } });
    expect(r).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32001, message: 'refused: x is not a tool this service may call' } });
    const u = await m.request({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    expect(u.error.code).toBe(-32601);
    const before = m.responses().length;
    m.stdin.write('not json\n');
    for (let i = 0; i < 100 && m.responses().length === before; i += 1) await new Promise((res) => setTimeout(res, 5));
    expect(m.responses()[before]).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    m.stdin.end();
    expect(await m.done).toBe(0);
  });

  it('a revoked client exits 3 with "revoked: pair again"', async () => {
    const m = startMcp({ listTools: (c) => { c.state = 'revoked'; const e = new Error('service client revoked'); e.code = 'revoked'; throw e; } });
    const r = await m.request({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(r.error.message).toBe(REVOKED_MSG);
    expect(await m.done).toBe(3);
    expect(m.err.text).toContain(REVOKED_MSG);
  });

  it('revocation at connect exits 3', async () => {
    const m = startMcp({ connect: (c) => { c.state = 'revoked'; const e = new Error('revoked'); e.code = 'revoked'; throw e; } });
    expect(await m.done).toBe(3);
    expect(m.err.text).toContain(REVOKED_MSG);
  });

  it('missing --state-dir is a usage error', async () => {
    const { factory } = fakeClient();
    expect(await runServiceCli(['mcp'], { stdin: new PassThrough(), stdout: sink().stream, stderr: sink().stream, clientFactory: factory })).toBe(2);
  });

  describe('pair-local', () => {
    function setup(routes) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
      const adminApiPath = path.join(dir, 'admin-api.json');
      fs.writeFileSync(adminApiPath, JSON.stringify({ port: 4321, token: 'tok' }));
      const reqs = [];
      const fetchImpl = async (url, init) => {
        reqs.push({ url, init, body: JSON.parse(init.body) });
        const r = routes(url);
        return { ok: r.status === 200, status: r.status, json: async () => r.body };
      };
      return { adminApiPath, fetchImpl, reqs };
    }
    const okRoutes = (confirm) => (url) => (url.endsWith('/confirm')
      ? (confirm || { status: 200, body: { ok: true, service: { id: 's1', name: 'Kiln' } } })
      : { status: 200, body: { ok: true, code: 'CODE', pairingId: 'p1' } });
    const base = ['pair-local', '--state-dir', '/s', '--name', 'Kiln', '--home', '/h', '--tools', 'a,b'];
    const run = (argv, io) => {
      const out = sink(); const err = sink();
      return runServiceCli(argv, { stdin: new PassThrough(), stdout: out.stream, stderr: err.stream, ...io }).then((code) => ({ code, out, err }));
    };

    it('success: posts start then confirm once, prints Paired locally', async () => {
      const { adminApiPath, fetchImpl, reqs } = setup(okRoutes());
      const { client, factory } = fakeClient({
        connect: async (c) => { c.opts.onSas('123456'); c.opts.onSas('123456'); await new Promise((r) => setTimeout(r, 5)); return { sas: '123456' }; },
      });
      const r = await run(base, { fetchImpl, adminApiPath, clientFactory: factory });
      expect(r.code).toBe(0);
      expect(r.out.text).toContain('Paired locally: Kiln');
      expect(reqs.length).toBe(2);
      expect(reqs[0].body).toEqual({ name: 'Kiln', homeCwd: '/h', tools: ['a', 'b'] });
      expect(reqs[0].init.headers.authorization).toBe('Bearer tok');
      expect(reqs[1].body).toEqual({ pairingId: 'p1', sas: '123456' });
      expect(client.calls[0]).toEqual(['pair', { code: 'CODE', name: 'Kiln' }]);
      expect(client.calls.some((c) => c[0] === 'close')).toBe(true);
      expect(r.err.text).not.toContain('tok');
    });

    it('web_remote_off refusal exits 1 naming the error', async () => {
      const { adminApiPath, fetchImpl } = setup(() => ({ status: 409, body: { ok: false, error: 'web_remote_off' } }));
      const { factory } = fakeClient();
      const r = await run(base, { fetchImpl, adminApiPath, clientFactory: factory });
      expect(r.code).toBe(1);
      expect(r.err.text).toContain('web_remote_off');
    });

    it('sas_mismatch on confirm fails even while connect hangs', async () => {
      const { adminApiPath, fetchImpl } = setup(okRoutes({ status: 403, body: { ok: false, error: 'sas_mismatch' } }));
      const { factory } = fakeClient({ connect: async (c) => { c.opts.onSas('111111'); return new Promise(() => {}); } });
      const r = await pairLocalWith(fetchImpl, adminApiPath, factory);
      expect(r).toEqual({ ok: false, error: 'sas_mismatch' });
    });

    it('missing admin-api.json', async () => {
      const r = await pairLocal({ stateDir: '/s', name: 'K', homeCwd: '/h', tools: ['a'], adminApiPath: '/nonexistent/admin-api.json' });
      expect(r).toEqual({ ok: false, error: 'session manager is not running (no admin-api.json)' });
      const c = await run(base, { adminApiPath: '/nonexistent/admin-api.json' });
      expect(c.code).toBe(1);
    });

    it('usage errors exit 2', async () => {
      for (const drop of ['--state-dir', '--name', '--home', '--tools']) {
        const argv = [...base];
        const i = argv.indexOf(drop);
        argv.splice(i, 2);
        expect((await run(argv, {})).code).toBe(2);
      }
    });

    function pairLocalWith(fetchImpl, adminApiPath, clientFactory) {
      return pairLocal({ stateDir: '/s', name: 'K', homeCwd: '/h', tools: ['a'], fetchImpl, adminApiPath, clientFactory });
    }
  });
});
