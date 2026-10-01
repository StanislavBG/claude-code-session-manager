/**
 * schedulerMcpServerGateFiles.test.cjs — scheduler_create_prd's `gate`/`files`
 * required-fields refusal (gate-and-files-in-PRD-body unit: 74% of parked
 * jobs had no gate the scheduler could read), and the renamed "Warnings:" /
 * added "Gate (...)" / "Files:" lines the tool appends to a successful
 * create-prd response.
 *
 * Same HOME-redirection pattern as schedulerMcpServerHeadlessRefusal.test.cjs
 * (local refusal, no admin server needed) and schedulerMcpServerHelp.test.cjs
 * (a real loopback HTTP server stands in for the admin API to exercise the
 * full response-formatting path).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerGateFiles.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');

const tmpDirs = [];
const servers = [];
let originalHome;

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
    originalHome = undefined;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) {
    const s = servers.pop();
    await new Promise((resolve) => s.close(resolve));
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-gate-files-'));
  tmpDirs.push(d);
  return d;
}

/** Starts a fake admin HTTP server answering every authenticated request with the same canned JSON body. */
function startFakeAdminServer(token, responseBody) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad token' }));
        return;
      }
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function writeAdminConfig(homeDir, { port, token }) {
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port, token }), 'utf8');
}

/** Requires a fresh scheduler-mcp-server.cjs with the admin token path resolved under `homeDir`. */
function requireServerWithHome(homeDir) {
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  delete require.cache[require.resolve(SERVER_PATH)];
  return require(SERVER_PATH);
}

function callTool(handleCallTool, name, args) {
  return handleCallTool({ params: { name, arguments: args } });
}

const VALID_GATE = ['timeout 300 npm run typecheck'];
const VALID_FILES = ['src/main/lib/foo.cjs'];

function baseArgs(overrides = {}) {
  return {
    title: 'x', goal: 'y', acceptanceCriteria: ['z'], gate: VALID_GATE, files: VALID_FILES, ...overrides,
  };
}

// ──────────────────────────────────────────── required-fields refusal

test('scheduler_create_prd without gate is refused before any admin request, naming both required fields', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  const args = baseArgs();
  delete args.gate;

  const result = await callTool(handleCallTool, 'scheduler_create_prd', args);

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/needs "gate"/);
  expect(result.content[0].text).toMatch(/"files"/);
  expect(result.content[0].text).not.toMatch(/never queues follow-on work/);
});

test('scheduler_create_prd with an empty gate array is refused the same way as a missing gate', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);

  const result = await callTool(handleCallTool, 'scheduler_create_prd', baseArgs({ gate: [] }));

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/needs "gate"/);
});

test('scheduler_create_prd without files is refused before any admin request', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  const args = baseArgs();
  delete args.files;

  const result = await callTool(handleCallTool, 'scheduler_create_prd', args);

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/needs "gate"/);
  expect(result.content[0].text).toMatch(/"files"/);
});

test('scheduler_create_prd with an empty files array is refused the same way as missing files', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);

  const result = await callTool(handleCallTool, 'scheduler_create_prd', baseArgs({ files: [] }));

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/needs "gate"/);
});

test('scheduler_create_prd with both gate and files present passes the local check and reaches the admin-request stage', async () => {
  // No admin config written under this tmp HOME — simulates the app not
  // running. The point here is which error fires: NOT_RUNNING_ERROR (reached
  // the forwarding logic), never the gate/files-needed refusal.
  const homeDir = await mkTmp();
  const { handleCallTool, NOT_RUNNING_ERROR } = requireServerWithHome(homeDir);

  const result = await callTool(handleCallTool, 'scheduler_create_prd', baseArgs());

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe(NOT_RUNNING_ERROR);
  expect(result.content[0].text).not.toMatch(/needs "gate"/);
});

// ──────────────────────────────────────────── response-text formatting
// (renamed "Warnings:" block + added "Gate (...)"/"Files:" lines)

test('scheduler_create_prd success response appends Warnings:, Gate (...), and Files: lines from the admin result', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const adminResult = {
    ok: true,
    nn: 5,
    filename: '5-x.md',
    enqueued: false,
    note: 'written',
    gate: { source: 'explicit', commands: ['timeout 300 npm run typecheck', 'timeout 600 npm run test:unit'] },
    files: ['src/main/lib/foo.cjs', 'src/main/lib/bar.cjs'],
    warnings: ['No files list: the executor is not told which files it may change.'],
  };
  const server = await startFakeAdminServer(token, adminResult);
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'scheduler_create_prd', baseArgs());

  expect(result.isError).toBeFalsy();
  const text = result.content[0].text;
  expect(text).toContain('\nWarnings:\n- No files list: the executor is not told which files it may change.');
  expect(text).toContain('\nGate (explicit): timeout 300 npm run typecheck && timeout 600 npm run test:unit');
  expect(text).toContain('\nFiles: src/main/lib/foo.cjs, src/main/lib/bar.cjs');
});

test('scheduler_create_prd success response omits the Warnings: line entirely when there are no warnings', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const adminResult = {
    ok: true,
    nn: 6,
    filename: '6-x.md',
    enqueued: true,
    note: 'written',
    gate: { source: 'none', commands: ['none'] },
    files: ['README.md'],
    warnings: [],
  };
  const server = await startFakeAdminServer(token, adminResult);
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'scheduler_create_prd', baseArgs({ gate: ['none'] }));

  expect(result.isError).toBeFalsy();
  const text = result.content[0].text;
  expect(text).not.toContain('Warnings:');
  expect(text).toContain('\nGate (none): none');
  expect(text).toContain('\nFiles: README.md');
});
