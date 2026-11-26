/**
 * chatRunner-gear.test.cjs — a Chat turn of an Epic whose pinned AgentSnapshot carries
 * gearBindsChat gets the job tool scope (persona tools, strict MCP, packs, skill deny-list);
 * unstamped (old) and Unbound snapshots add nothing. argv is captured from a stub claude bin.
 *
 * Run: timeout 200 npx vitest run src/main/__tests__/chatRunner-gear.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome; let tmpDir; let originalHome; let originalBin; let cr; let sent; let n = 0;
let snapshotMod; let opsPath; let packId;

beforeAll(() => {
  originalHome = process.env.HOME;
  originalBin = process.env.SM_CLAUDE_BIN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatgear-home-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatgear-work-'));
  process.env.HOME = tmpHome;
  cr = require('../chatRunner.cjs');
  snapshotMod = require('../lib/claude/agentSnapshot.cjs');
  opsPath = require('../lib/opsOwnership.cjs').opsPath;
  const packs = require('../lib/packs/packCatalog.cjs').listPacks().packs;
  packId = packs.length ? packs[0].id : 'no-such-pack';
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalBin === undefined) delete process.env.SM_CLAUDE_BIN; else process.env.SM_CLAUDE_BIN = originalBin;
  for (const d of [tmpHome, tmpDir]) fs.rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  cr.__resetQueueForTests();
  cr.attachWindow(null);
});

function writeStub(logFile) {
  const stubPath = path.join(tmpDir, `stub-${++n}.cjs`);
  const body = `
    const fs = require('fs');
    process.stdin.resume();
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {
      fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK', is_error: false }) + '\\n');
      process.exit(0);
    });
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

async function waitFor(pred, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Mint a project with one Epic pinned to `snapshotExtra` (null = no snapshot), run one turn, return argv. */
async function runTurn(snapshotExtra) {
  const sid = `0b7e2f4c-9a1d-4c3e-8f2a-${String(100000000000 + ++n)}`;
  const cwd = fs.mkdtempSync(path.join(tmpDir, 'cwd-'));
  const epic = { id: `epic-${n}`, claudeSessionId: sid, status: 'active', developLoop: false };
  if (snapshotExtra) {
    const snap = {
      name: 'gear-tester', bodySha256: 'x', body: 'You are a tester.', model: 'sonnet', effort: null,
      tools: [], mcpServers: [], packs: [], seedVersion: null, environment: { id: 'default', hash: 'h' },
      ...snapshotExtra,
    };
    const id = snapshotMod.snapshotId(snap);
    const file = opsPath(cwd, 'agents', 'snapshots', `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snap));
    epic.agentSnapshotId = id;
    epic.agentType = 'gear-tester';
  }
  const idx = opsPath(cwd, 'prompt-sessions', 'active-index.json');
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  fs.writeFileSync(idx, JSON.stringify({ sessions: { [epic.id]: epic }, events: {}, tombstones: {} }));

  const logFile = path.join(tmpDir, `log-${n}.jsonl`);
  process.env.SM_CLAUDE_BIN = writeStub(logFile);
  sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
  cr.run({ tabId: sid, sessionId: sid, cwd, prompt: 'hi' });
  expect(await waitFor(() => fs.existsSync(logFile))).toBe(true);
  return JSON.parse(fs.readFileSync(logFile, 'utf8').split('\n')[0]).argv;
}

const MCP = 'session-manager-scheduler';

test('stamped Bare persona: floor-only scope, strict MCP with no server', async () => {
  const argv = await runTurn({ gearBindsChat: true, loadout: 'bare' });
  const agents = JSON.parse(argv[argv.indexOf('--agents') + 1]);
  expect(Object.values(agents)[0].tools).toEqual(['Agent', 'Skill', 'ToolSearch', 'TodoWrite']);
  expect(argv).toContain('--strict-mcp-config');
  expect(argv).not.toContain('--mcp-config');
  expect(argv.join(' ')).not.toContain('--disallowedTools=Bash');
});

test('stamped Equipped persona: persona tools, declared server and pack', async () => {
  const argv = await runTurn({
    gearBindsChat: true, loadout: 'equipped', tools: ['Read', `mcp__${MCP}__project_matrix_read`],
    mcpServers: [MCP], packs: [packId],
  });
  const agents = JSON.parse(argv[argv.indexOf('--agents') + 1]);
  expect(Object.values(agents)[0].tools).toEqual(expect.arrayContaining(['Read', `mcp__${MCP}__project_matrix_read`, 'Skill']));
  const mcp = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
  expect(Object.keys(mcp.mcpServers)).toEqual([MCP]);
  expect(argv).toContain('--strict-mcp-config');
  if (packId !== 'no-such-pack') expect(argv).toContain('--plugin-dir');
  expect(sent.find((e) => e.channel === 'chat:run:error')).toBeUndefined();
});

test('unknown declared server: turn runs without it and a notice is emitted', async () => {
  const argv = await runTurn({ gearBindsChat: true, loadout: 'equipped', tools: ['Read'], mcpServers: ['ghost-server'] });
  expect(argv).toContain('--strict-mcp-config');
  expect(argv).not.toContain('--mcp-config');
  expect(sent.some((e) => e.channel === 'chat:run:notice' && /ghost-server/.test(e.payload.message))).toBe(true);
});

test('unstamped (old) Epic: argv unchanged', async () => {
  const argv = await runTurn({ loadout: 'bare' });
  expect(argv).not.toContain('--agents');
  expect(argv).not.toContain('--strict-mcp-config');
  expect(argv.some((a) => a.startsWith('--disallowedTools'))).toBe(false);
});

test('Unbound snapshot adds no tool-scope args', async () => {
  const argv = await runTurn({ gearBindsChat: true, loadout: 'unbound', tools: ['Read'] });
  expect(argv).not.toContain('--agents');
  expect(argv).not.toContain('--strict-mcp-config');
});

test('Undecided snapshot runs unscoped and logs once', async () => {
  const logs = [];
  const snap = { name: 'undecided-one', gearBindsChat: true, loadout: 'undecided', tools: ['Read'] };
  expect(cr.gearChatArgs({ snapshot: snap, deps: { log: (m) => logs.push(m) } }).args).toEqual([]);
  expect(cr.gearChatArgs({ snapshot: snap, deps: { log: (m) => logs.push(m) } }).args).toEqual([]);
  expect(logs).toHaveLength(1);
});
