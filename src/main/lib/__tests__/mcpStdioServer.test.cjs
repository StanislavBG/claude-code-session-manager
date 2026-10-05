/**
 * mcpStdioServer.test.cjs — newline-delimited JSON-RPC MCP server over
 * PassThrough streams: initialize negotiation, tools/list, tools/call,
 * notifications, error codes, and chunk-split framing.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/mcpStdioServer.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { PassThrough } = require('node:stream');
const { createStdioServer, SUPPORTED_PROTOCOL_VERSIONS } = require('../mcpStdioServer.cjs');

function harness(overrides = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = '';
  output.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const server = createStdioServer({
    name: 'test-server',
    version: '1.2.3',
    listTools: () => [{ name: 'echo', inputSchema: { type: 'object' } }],
    callTool: async (params) => ({ content: [{ type: 'text', text: `ran ${params.name}` }] }),
    input,
    output,
    ...overrides,
  });
  server.start();
  const waitFor = async (n) => {
    for (let i = 0; i < 200 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 5));
    return lines;
  };
  const send = (msg) => input.write(JSON.stringify(msg) + '\n');
  return { input, lines, server, send, waitFor };
}

test('initialize echoes a supported protocolVersion', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const [r] = await h.waitFor(1);
  expect(r).toEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1.2.3' },
    },
  });
  h.server.close();
});

test('initialize falls back to latest for unsupported version', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  const [r] = await h.waitFor(1);
  expect(r.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  h.server.close();
});

test('ping, tools/list and tools/call succeed', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} } });
  const out = await h.waitFor(3);
  const byId = Object.fromEntries(out.map((m) => [m.id, m]));
  expect(byId[1].result).toEqual({});
  expect(byId[2].result.tools[0].name).toBe('echo');
  expect(byId[3].result.content[0].text).toBe('ran echo');
  h.server.close();
});

test('notification gets no reply', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  const out = await h.waitFor(1);
  await new Promise((r) => setTimeout(r, 30));
  expect(h.lines).toHaveLength(1);
  expect(out[0].id).toBe(9);
  h.server.close();
});

test('unknown method -> -32601', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', id: 4, method: 'nope/nothing' });
  const [r] = await h.waitFor(1);
  expect(r.id).toBe(4);
  expect(r.error.code).toBe(-32601);
  h.server.close();
});

test('invalid JSON -> -32700 with null id, server keeps working', async () => {
  const h = harness();
  h.input.write('{not json\n');
  h.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
  const out = await h.waitFor(2);
  expect(out[0].id).toBeNull();
  expect(out[0].error.code).toBe(-32700);
  expect(out[1].result).toEqual({});
  h.server.close();
});

test('callTool and listTools throwing -> -32603 with message', async () => {
  const h = harness({
    callTool: async () => {
      throw new Error('boom');
    },
    listTools: () => {
      throw new Error('list-fail');
    },
  });
  h.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'x' } });
  h.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  const out = await h.waitFor(2);
  const byId = Object.fromEntries(out.map((m) => [m.id, m]));
  expect(byId[6].error).toMatchObject({ code: -32603, message: 'boom' });
  expect(byId[7].error).toMatchObject({ code: -32603, message: 'list-fail' });
  h.server.close();
});

test('request split across two input chunks is buffered', async () => {
  const h = harness();
  const line = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) + '\n';
  h.input.write(line.slice(0, 10));
  await new Promise((r) => setTimeout(r, 20));
  expect(h.lines).toHaveLength(0);
  h.input.write(line.slice(10));
  const [r] = await h.waitFor(1);
  expect(r).toEqual({ jsonrpc: '2.0', id: 8, result: {} });
  h.server.close();
});
