/**
 * schedulerMcpServerStdio.test.cjs — spawns the real scheduler MCP server and
 * speaks newline-delimited JSON-RPC to it over stdio (initialize, tools/list).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerStdio.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { TOOLS } = require(SERVER_PATH);

const children = [];

afterEach(() => {
  while (children.length) {
    const c = children.pop();
    if (c.exitCode === null) c.kill('SIGKILL');
  }
});

function collectResponses(child, wantIds) {
  return new Promise((resolve, reject) => {
    const got = new Map();
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) got.set(msg.id, msg);
        if (wantIds.every((id) => got.has(id))) resolve(got);
      }
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('server exited before responding')));
  });
}

test('spawned scheduler MCP server answers initialize + tools/list over stdio', async () => {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'ignore'] });
  children.push(child);
  const pending = collectResponses(child, [1, 2]);
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const got = await pending;
  expect(got.get(1).result.serverInfo.name).toBe('session-manager-scheduler');
  expect(got.get(2).result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
}, 30000);
