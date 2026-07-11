/**
 * mcpStatus.test.cjs — unit tests for the `claude mcp list` output parser.
 *
 * Run: timeout 120 node --test src/main/__tests__/mcpStatus.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMcpList } = require('../mcpStatus.cjs');

const SAMPLE = `Checking MCP server health…

claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
fetch: uvx mcp-server-fetch - ✔ Connected
n8n: bash /home/bilko/.config/n8n-mcp/run.sh - ✘ Failed to connect
session-manager-scheduler: node scripts/scheduler-mcp-server.cjs - ⏸ Pending approval (run \`claude\` to approve)
claude_design: https://api.anthropic.com/v1/design/mcp (HTTP) - ✔ Connected
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication
`;

test('parses the captured claude mcp list sample', () => {
  const servers = parseMcpList(SAMPLE);
  assert.ok(servers.length >= 6, `expected >=6 servers, got ${servers.length}`);

  const byName = Object.fromEntries(servers.map((s) => [s.name, s]));

  assert.equal(byName['claude.ai Gmail'].status, 'connected');
  assert.equal(byName['fetch'].status, 'connected');
  assert.equal(byName['n8n'].status, 'failed');
  assert.equal(byName['session-manager-scheduler'].status, 'pending');
  assert.equal(byName['claude_design'].status, 'connected');
  assert.equal(byName['claude_design'].transport, 'http');
  assert.equal(byName['claude.ai Google Drive'].status, 'needs-auth');
});

test('ignores the header and blank lines', () => {
  const servers = parseMcpList(SAMPLE);
  assert.ok(!servers.some((s) => /Checking MCP server health/i.test(s.name)));
});

test('defaults transport to stdio for non-HTTP targets', () => {
  const servers = parseMcpList(SAMPLE);
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
  assert.equal(byName['n8n'].transport, 'stdio');
  assert.equal(byName['fetch'].transport, 'stdio');
});

test('returns [] (not a throw) on empty input', () => {
  assert.deepEqual(parseMcpList(''), []);
});

test('returns [] (not a throw) on garbage input', () => {
  assert.deepEqual(parseMcpList('this is not\na valid mcp list output\n12345'), []);
});

test('returns [] on non-string input without throwing', () => {
  assert.deepEqual(parseMcpList(null), []);
  assert.deepEqual(parseMcpList(undefined), []);
});
