/**
 * schedulerMcpServerJobToolScope.test.cjs — SM_SCHEDULER_JOB_MCP_TOOLS scoping,
 * against the real server over stdio.
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { TOOLS } = require(SERVER_PATH);
const HELP = 'mcp__session-manager-scheduler__session_manager_help';

const children = [];
afterEach(() => {
  while (children.length) {
    const c = children.pop();
    if (c.exitCode === null) c.kill('SIGKILL');
  }
});

function run(scope) {
  const env = { ...process.env, SM_SCHEDULER_JOB_SLUG: 'probe-job' };
  delete env.SM_SCHEDULER_JOB_MCP_TOOLS;
  if (scope !== undefined) env.SM_SCHEDULER_JOB_MCP_TOOLS = scope;
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'ignore'], env });
  children.push(child);
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
        if (got.has(2) && got.has(3)) resolve({ list: got.get(2).result.tools.map((t) => t.name), call: got.get(3).result });
      }
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('server exited before responding')));
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_demo_video_write', arguments: { html: '<p>x</p>' } } });
  });
}

const text = (r) => r.content[0].text;

test('unset: no filter, no scope refusal', async () => {
  const { list, call } = await run(undefined);
  expect(list).toEqual(TOOLS.map((t) => t.name));
  expect(text(call)).not.toMatch(/outside the tool scope|malformed/);
}, 30000);

test('listed: only in-scope tools, others refused naming tool and slug', async () => {
  const { list, call } = await run(JSON.stringify([HELP]));
  expect(list).toEqual(['session_manager_help']);
  expect(call.isError).toBe(true);
  expect(text(call)).toMatch(/^refused:/);
  expect(text(call)).toContain('project_demo_video_write');
  expect(text(call)).toContain('probe-job');
  expect(text(call)).not.toContain('session_manager_help');
}, 30000);

test('empty array: no tools, call refused', async () => {
  const { list, call } = await run('[]');
  expect(list).toEqual([]);
  expect(text(call)).toMatch(/^refused:/);
}, 30000);

test.each(['not json', '{"a":1}', '[1,2]'])('malformed %s fails closed', async (bad) => {
  const { list, call } = await run(bad);
  expect(list).toEqual([]);
  expect(call.isError).toBe(true);
  expect(text(call)).toContain('SM_SCHEDULER_JOB_MCP_TOOLS is malformed');
}, 30000);
