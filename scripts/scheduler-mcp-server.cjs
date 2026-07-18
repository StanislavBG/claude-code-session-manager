#!/usr/bin/env node
/**
 * scheduler-mcp-server.cjs — stdio MCP server wrapping PRD 448's loopback
 * admin HTTP API (src/main/adminServer.cjs). Exposes two tools:
 *
 *   scheduler_reset_job({ slug }) -> POST /admin/scheduler/reset-job
 *   scheduler_list_jobs()         -> GET  /admin/scheduler/jobs
 *
 *   scheduler_create_prd({ ... })  -> POST /admin/scheduler/create-prd
 *
 * This is a separate process from the Electron app — it only ever reaches
 * it over the token-authed loopback HTTP API in admin-api.json, never by
 * requiring scheduler.cjs/adminServer.cjs directly. The admin server IS the
 * security boundary; this file stays on the client side of it.
 */

'use strict';

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const TOKEN_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'admin-api.json');

const NOT_RUNNING_ERROR =
  'session-manager app is not running (admin API unreachable) — start it first';

async function readAdminConfig() {
  const raw = await fsp.readFile(TOKEN_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.port !== 'number' || typeof parsed.token !== 'string') {
    throw new Error(NOT_RUNNING_ERROR);
  }
  return parsed;
}

async function adminRequest(method, urlPath, body) {
  let port, token;
  try {
    ({ port, token } = await readAdminConfig());
  } catch {
    throw new Error(NOT_RUNNING_ERROR);
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(NOT_RUNNING_ERROR);
  }
  const json = await res.json();
  return json;
}

const TOOLS = [
  {
    name: 'scheduler_reset_job',
    description: "Reset a stuck scheduler job by slug via the session-manager app's admin API.",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'PRD slug of the job to reset' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'scheduler_list_jobs',
    description: "List scheduler jobs via the session-manager app's admin API.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'scheduler_create_prd',
    description:
      "Queue a new scheduled PRD via the session-manager app's admin API. Server-side "
      + 'validates the frontmatter, atomically allocates the NN parallel-group number, '
      + 'appends the engineering standards, and writes the PRD file. Falls back: if the '
      + 'app is not running, author the PRD file by hand instead (see /develop).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One-line human-readable title' },
        cwd: { type: 'string', description: 'Absolute path to the target project (where claude -p will run)' },
        estimateMinutes: { type: 'number', description: 'Integer wall-clock estimate in minutes' },
        goal: { type: 'string', description: '2-4 sentences: what the executor will build and why' },
        acceptanceCriteria: {
          type: 'array', items: { type: 'string' },
          description: 'Each entry is one verifiable checklist line',
        },
        implementationNotes: { type: 'string', description: 'File paths, patterns, and constraints the executor needs' },
        outOfScope: { type: 'array', items: { type: 'string' }, description: 'Optional: what NOT to build' },
        slug: { type: 'string', description: 'Optional kebab-case slug; derived from title if omitted' },
        parallelGroup: { type: 'number', description: 'Optional: opt into an existing NN group instead of allocating a new one' },
      },
      required: ['title', 'cwd', 'estimateMinutes', 'goal', 'acceptanceCriteria', 'implementationNotes'],
    },
  },
];

const server = new Server(
  { name: 'session-manager-scheduler', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'scheduler_reset_job') {
      const slug = args && typeof args.slug === 'string' ? args.slug : null;
      if (!slug) {
        return { content: [{ type: 'text', text: 'missing required argument: slug' }], isError: true };
      }
      const result = await adminRequest('POST', '/admin/scheduler/reset-job', { slug });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_list_jobs') {
      const result = await adminRequest('GET', '/admin/scheduler/jobs');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'scheduler_create_prd') {
      const result = await adminRequest('POST', '/admin/scheduler/create-prd', args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`scheduler-mcp-server fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
