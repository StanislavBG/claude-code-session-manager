/**
 * mcpToolsProbe.test.cjs — checkMcpServer speaks MCP to ONE server
 * (initialize → notifications/initialized → tools/list) over stdio or HTTP,
 * bounded by a timeout and a 2 MB output cap, resolving (never rejecting),
 * and leaving no server process — nor anything in its process group — behind.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/mcpToolsProbe.test.cjs
 */

'use strict';

import { afterAll, beforeAll, describe, test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { checkMcpServer } = require('../lib/mcpToolsProbe.cjs');

// The fixture stdio server. argv: <mode> <logFile>. It records its pid, the env
// it got and every message it received in <logFile>. String.raw keeps the
// escapes intact, so the source below must not use template placeholders.
const FIXTURE_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [mode, logFile] = process.argv.slice(2);
const log = {
  pid: process.pid,
  grandchildPid: null,
  env: {
    flag: process.env.FIXTURE_FLAG ?? null,
    apiKey: process.env.FIXTURE_API_KEY ?? null,
    parentSecret: process.env.SM_PROBE_PARENT_SECRET_TOKEN ?? null,
    role: process.env.SM_PROC_ROLE ?? null,
  },
  received: [],
};
const save = () => fs.writeFileSync(logFile, JSON.stringify(log));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

if (mode === 'hang') {
  // Never answers, ignores SIGTERM, and owns a grandchild (deaf to SIGTERM too,
  // and carrying logFile in its argv) in its process group: only a SIGKILL to
  // the whole group ends both.
  process.on('SIGTERM', () => {});
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", logFile], { stdio: 'ignore' });
  log.grandchildPid = grandchild.pid;
  save();
  setInterval(() => {}, 1000);
} else {
  save();
  if (mode === 'garbage') {
    process.stdout.write('this is not json\n{"half":\n');
    setTimeout(() => process.exit(0), 50);
  }
  if (mode === 'huge') process.stdout.write('x'.repeat(3 * 1024 * 1024));
  if (mode === 'leak') process.stderr.write('Error: bad credentials ' + process.env.FIXTURE_API_KEY + '\n', () => process.exit(1));
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      log.received.push(msg);
      save();
      if (mode !== 'good' && mode !== 'badtools') continue;
      if (msg.method === 'initialize') {
        process.stdout.write('fixture banner on stdout, not JSON-RPC\n');
        send({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
      } else if (msg.method === 'tools/list') {
        if (mode === 'badtools') send({ jsonrpc: '2.0', id: msg.id, result: { tools: 'not-an-array' } });
        else if (!msg.params || !msg.params.cursor) send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'alpha', description: 'First tool', inputSchema: { type: 'object' } }], nextCursor: 'page-2' } });
        else send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'beta', description: 'Second tool', inputSchema: { type: 'object' } }] } });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
`;

const TWO_TOOLS = [
  { name: 'alpha', description: 'First tool' },
  { name: 'beta', description: 'Second tool' },
];

let dir;
let fixture;
let caseNo = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-probe-'));
  fixture = path.join(dir, 'fixture-server.cjs');
  fs.writeFileSync(fixture, FIXTURE_SOURCE);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fixture server config, plus the per-case log file it writes. */
function fixtureServer(mode, extra = {}) {
  const logFile = path.join(dir, `case-${++caseNo}-${mode}.json`);
  return { server: { command: process.execPath, args: [fixture, mode, logFile], ...extra }, logFile };
}

/** The fixture's log; null only if it was killed before its first line ran. */
function readLog(logFile) {
  return fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : null;
}

/** True once `pid` no longer runs. A zombie (dead, awaiting its reaper) counts as gone. */
function isGone(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'ESRCH'; }
  if (process.platform !== 'linux') return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.charAt(stat.lastIndexOf(')') + 2);
    return state === 'Z' || state === 'X';
  } catch {
    return true; // exited between the two probes
  }
}

/** Pids of live processes whose argv carries `marker` (a zombie's argv is empty). */
function processesWith(marker) {
  if (process.platform === 'linux') {
    const found = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if (fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(marker)) found.push(Number(name));
      } catch { /* exited mid-scan */ }
    }
    return found;
  }
  const out = require('node:child_process').execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(marker)).map((l) => Number(l.trim().split(/\s+/)[0]));
}

/** Nothing from this case is still running: the server pid (already reaped when
 *  checkMcpServer resolved) and anything it spawned (reaped by init shortly after). */
async function assertServerGone(logFile) {
  const log = readLog(logFile);
  if (log) assert.ok(isGone(log.pid), `server pid ${log.pid} still running after checkMcpServer resolved`);
  const deadline = Date.now() + 3000;
  let left = processesWith(logFile);
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    left = processesWith(logFile);
  }
  assert.deepEqual(left, [], `processes still running for ${path.basename(logFile)}`);
  return log;
}

const verdict = (r) => ({ ok: r.ok, status: r.status, error: r.error });

describe('stdio', () => {
  test('answers initialize + 2 pages of tools/list → connected with 2 tools; server gone after', async () => {
    const { server, logFile } = fixtureServer('good', {
      env: { FIXTURE_FLAG: 'from-config', FIXTURE_API_KEY: 'fixture-key-123456' },
    });
    process.env.SM_PROBE_PARENT_SECRET_TOKEN = 'parent-secret-value';
    let r;
    try {
      r = await checkMcpServer(server, { timeoutMs: 10_000, clientVersion: '9.9.9-test' });
    } finally {
      delete process.env.SM_PROBE_PARENT_SECRET_TOKEN;
    }

    assert.equal(r.ok, true, r.error);
    assert.equal(r.status, 'connected');
    assert.deepEqual(r.tools, TWO_TOOLS);
    assert.equal(typeof r.checkedAt, 'number');

    const log = await assertServerGone(logFile);
    const [init, pong, initialized, page1, page2, ...rest] = log.received;
    assert.equal(init.method, 'initialize');
    assert.deepEqual(init.params, {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'session-manager', version: '9.9.9-test' },
    });
    // The server's ping (a request) is answered; the stdout banner is tolerated.
    assert.deepEqual(pong, { jsonrpc: '2.0', id: 'srv-ping', result: {} });
    assert.deepEqual(initialized, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(page1.method, 'tools/list');
    assert.deepEqual(page1.params, {});
    assert.equal(page2.method, 'tools/list');
    assert.deepEqual(page2.params, { cursor: 'page-2' });
    assert.deepEqual(rest, []);
    // Cleaned app env plus server.env: the config's env (even a secret-named
    // key) arrives; the app's own secrets do not.
    assert.deepEqual(log.env, { flag: 'from-config', apiKey: 'fixture-key-123456', parentSecret: null, role: 'aux' });
  });

  test('a server that never answers, timeoutMs 300 → failed "timed out after 0.3s"; it and its process group are killed', async () => {
    const { server, logFile } = fixtureServer('hang');
    const r = await checkMcpServer(server, { timeoutMs: 300 });
    assert.deepEqual(verdict(r), { ok: false, status: 'failed', error: 'timed out after 0.3s' });
    await assertServerGone(logFile); // the SIGTERM-deaf grandchild too: its argv carries logFile
  });

  test('garbage on stdout, then exit → failed (not a hang, not a rejection); server gone', async () => {
    const { server, logFile } = fixtureServer('garbage');
    const r = await checkMcpServer(server, { timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    assert.match(r.error, /^server exited \(code 0\) before answering initialize/);
    assert.match(r.error, /stdout was not JSON-RPC: this is not json/);
    await assertServerGone(logFile);
  });

  test('a garbage tools/list result → failed; server gone', async () => {
    const { server, logFile } = fixtureServer('badtools');
    const r = await checkMcpServer(server, { timeoutMs: 10_000 });
    assert.deepEqual(verdict(r), { ok: false, status: 'failed', error: 'tools/list returned no tools array' });
    await assertServerGone(logFile);
  });

  test('more than 2 MB on stdout → failed "output too large"; server gone', async () => {
    const { server, logFile } = fixtureServer('huge');
    const r = await checkMcpServer(server, { timeoutMs: 10_000 });
    assert.deepEqual(verdict(r), { ok: false, status: 'failed', error: 'output too large' });
    await assertServerGone(logFile);
  });

  test('stderr shows in the error, but env values never do', async () => {
    const { server, logFile } = fixtureServer('leak', { env: { FIXTURE_API_KEY: 'fixture-key-123456' } });
    const r = await checkMcpServer(server, { timeoutMs: 10_000 });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /^server exited \(code 1\) before answering initialize: Error: bad credentials \*\*\*$/);
    assert.ok(!r.error.includes('fixture-key-123456'), r.error);
    await assertServerGone(logFile);
  });

  test('a missing command → failed, never a rejection', async () => {
    const r = await checkMcpServer({ command: path.join(dir, 'no-such-server') }, { timeoutMs: 10_000 });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /^command not found: /);
  });
});

describe('config shapes', () => {
  test('unusable configs resolve to failed with a reason', async () => {
    const cases = [
      [null, 'invalid server config'],
      [{}, 'server has no command or url'],
      [{ type: 'http' }, 'server has no url'],
      [{ url: 'not a url' }, 'invalid url'],
      [{ type: 'ws', url: 'ws://127.0.0.1:1/mcp' }, 'unsupported transport: ws'],
    ];
    for (const [server, error] of cases) {
      const r = await checkMcpServer(server);
      assert.deepEqual(verdict(r), { ok: false, status: 'failed', error }, JSON.stringify(server));
      assert.equal(typeof r.checkedAt, 'number');
    }
  });
});

/** A throwaway HTTP endpoint; `handle(msg, req, res)` answers each request. */
function startHttp(handle) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, headers: req.headers, msg });
      handle(msg, req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        seen,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

const json = (res, status, body, headers = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

describe('http', () => {
  test('JSON and SSE replies, Mcp-Session-Id carried → connected with 2 tools', async () => {
    const srv = await startHttp((msg, req, res) => {
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-123') {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'missing session' } });
        return;
      }
      if (msg.method === 'initialize') {
        json(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } },
        }, { 'mcp-session-id': 'sess-123' });
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end();
      } else if (msg.method === 'tools/list' && !(msg.params && msg.params.cursor)) {
        // SSE: a comment, then the reply pretty-printed across several data:
        // lines, and the stream deliberately left open afterwards.
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'alpha', description: 'First tool', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
        }, null, 2);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`: keep-alive\n\nevent: message\n${reply.split('\n').map((l) => `data: ${l}`).join('\n')}\n\n`);
      } else if (msg.method === 'tools/list') {
        json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'beta', description: 'Second tool' }] } });
      }
    });
    try {
      const r = await checkMcpServer(
        { type: 'http', url: srv.url, headers: { 'X-Api-Key': 'http-key-abcdef' } },
        { timeoutMs: 10_000, clientVersion: '9.9.9-test' },
      );
      assert.equal(r.ok, true, r.error);
      assert.equal(r.status, 'connected');
      assert.deepEqual(r.tools, TWO_TOOLS);

      const posts = srv.seen.filter((s) => s.method === 'POST');
      assert.deepEqual(posts.map((p) => p.msg.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
      assert.deepEqual(posts[0].msg.params, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'session-manager', version: '9.9.9-test' },
      });
      for (const p of posts) {
        assert.equal(p.headers.accept, 'application/json, text/event-stream');
        assert.equal(p.headers['content-type'], 'application/json');
        assert.equal(p.headers['x-api-key'], 'http-key-abcdef');
      }
      assert.equal(posts[0].headers['mcp-session-id'], undefined);
      for (const p of posts.slice(1)) {
        assert.equal(p.headers['mcp-session-id'], 'sess-123');
        assert.equal(p.headers['mcp-protocol-version'], '2025-06-18');
      }
      assert.deepEqual(posts[3].msg.params, { cursor: 'page-2' });
      // The session is ended on the way out.
      const del = srv.seen.find((s) => s.method === 'DELETE');
      assert.equal(del && del.headers['mcp-session-id'], 'sess-123');
    } finally {
      await srv.close();
    }
  });

  test('HTTP 401 / 403 → needs-auth, and the credential never appears in the error', async () => {
    for (const code of [401, 403]) {
      const srv = await startHttp((msg, req, res) => {
        json(res, code, { error: `invalid token ${req.headers.authorization}` }, { 'www-authenticate': 'Bearer realm="mcp"' });
      });
      try {
        const r = await checkMcpServer({ url: srv.url, headers: { Authorization: 'Bearer http-secret-token-value' } }, { timeoutMs: 10_000 });
        assert.equal(r.ok, false);
        assert.equal(r.status, 'needs-auth', r.error);
        assert.ok(!r.error.includes('http-secret-token-value'), r.error);
      } finally {
        await srv.close();
      }
    }
  });

  test('a server error echoing a header value → failed, value redacted', async () => {
    const srv = await startHttp((msg, req, res) => {
      json(res, 500, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `bad key ${req.headers['x-api-key']}` } });
    });
    try {
      const r = await checkMcpServer({ type: 'http', url: srv.url, headers: { 'X-Api-Key': 'http-key-abcdef' } }, { timeoutMs: 10_000 });
      assert.deepEqual(verdict(r), { ok: false, status: 'failed', error: 'HTTP 500: bad key ***' });
    } finally {
      await srv.close();
    }
  });

  test('a reply body over 2 MB → failed "output too large"', async () => {
    const srv = await startHttp((msg, req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(`{"jsonrpc":"2.0","id":${msg.id},"result":{"pad":"`);
      res.write('x'.repeat(3 * 1024 * 1024));
      res.end('"}}');
    });
    try {
      const r = await checkMcpServer({ type: 'http', url: srv.url }, { timeoutMs: 10_000 });
      assert.deepEqual(verdict(r), { ok: false, status: 'failed', error: 'output too large' });
    } finally {
      await srv.close();
    }
  });

  test('no reply, timeoutMs 300 → failed "timed out after 0.3s"', async () => {
    const srv = await startHttp(() => { /* never answers */ });
    try {
      const r = await checkMcpServer({ type: 'http', url: srv.url }, { timeoutMs: 300 });
      assert.deepEqual(verdict(r), { ok: false, status: 'failed', error: 'timed out after 0.3s' });
    } finally {
      await srv.close();
    }
  });
});
