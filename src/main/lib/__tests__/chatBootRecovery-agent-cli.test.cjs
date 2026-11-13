/**
 * chatBootRecovery-agent-cli.test.cjs — boot recovery skips non-Claude agent-CLI Epics.
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/chatBootRecovery-agent-cli.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { recoverInflightTurns } = require('../chatBootRecovery.cjs');
const { activeIndexPath } = require('../epic/epicMint.cjs');

const SID = '11111111-2222-4333-8444-555555555555';
const saved = {};
const tmpDirs = [];

beforeEach(async () => {
  for (const k of ['HOME', 'SM_AGENT_CLI_STATE_DIR']) saved[k] = process.env[k];
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cbr-home-'));
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cbr-state-'));
  tmpDirs.push(home, state);
  process.env.HOME = home;
  process.env.SM_AGENT_CLI_STATE_DIR = state;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function project(sessionRec) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cbr-cwd-'));
  tmpDirs.push(cwd);
  fs.mkdirSync(path.dirname(activeIndexPath(cwd)), { recursive: true });
  fs.writeFileSync(activeIndexPath(cwd), JSON.stringify({ sessions: { 'epic-1': { id: 'epic-1', cwd, claudeSessionId: SID, status: 'active', ...sessionRec } }, events: {}, tombstones: {} }));
  return cwd;
}

function harness(entries) {
  const calls = { run: [], end: [], log: [], turnState: 0 };
  const deps = {
    ledger: {
      list: async () => entries,
      end: async (s) => { calls.end.push(s); },
      markRecovered: async () => {},
      recoveredMap: async () => ({}),
    },
    run: (o) => { calls.run.push(o); },
    pidAlive: () => false,
    sessionTurnState: async () => { calls.turnState += 1; return 'unfinished'; },
    now: () => 1_800_000_000_000,
    log: (l) => calls.log.push(l),
  };
  return { deps, calls };
}

test('non-Claude agentCli Epic (looked up via promptId in the active index): no re-run, logged once, ledger cleared', async () => {
  const cwd = await project({ agentCli: 'codex', agentCliModel: 'gpt-5' });
  const h = harness([{ sessionId: SID, tabId: 't', cwd, pid: 1, promptId: 'epic-1' }]);
  const { results, pending } = await recoverInflightTurns(h.deps);
  await pending;
  expect(h.calls.run).toEqual([]);
  expect(h.calls.turnState).toBe(0);
  expect(h.calls.end).toEqual([SID]);
  expect(h.calls.log).toHaveLength(1);
  expect(h.calls.log[0].message).toContain(SID);
  expect(results[0]).toMatchObject({ sessionId: SID, outcome: 'skipped_agent_cli', agentCli: 'codex' });
});

test('non-Claude Epic found by claudeSessionId when the entry has no promptId', async () => {
  const cwd = await project({ agentCli: 'gemini' });
  const h = harness([{ sessionId: SID, tabId: 't', cwd, pid: 1 }]);
  const { results } = await recoverInflightTurns(h.deps);
  expect(h.calls.run).toEqual([]);
  expect(h.calls.end).toEqual([SID]);
  expect(results[0].outcome).toBe('skipped_agent_cli');
});

test('Claude Epic (agentCli absent or "claude") still re-runs an unfinished turn', async () => {
  for (const rec of [{}, { agentCli: 'claude' }]) {
    const cwd = await project(rec);
    const h = harness([{ sessionId: SID, tabId: 't', cwd, pid: 1, promptId: 'epic-1' }]);
    const { results } = await recoverInflightTurns(h.deps);
    expect(results[0].outcome).toBe('rerun');
    expect(h.calls.run).toHaveLength(1);
    expect(h.calls.log).toEqual([]);
  }
});
