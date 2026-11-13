/**
 * archivedTranscript-agent-cli.test.cjs — archiving a non-Claude agent-CLI Epic gzips
 * the agentCliSessionStore transcript into the usual sidecar.
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/archivedTranscript-agent-cli.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { archiveTranscript, readSidecar } = require('../archivedTranscript.cjs');
const { activeIndexPath } = require('../epicMint.cjs');
const { epicMirrorPath } = require('../epicStatusMirror.cjs');
const { transcriptPathFor } = require('../../agent-cli/agentCliSessionStore.cjs');

const SID = '11111111-2222-4333-8444-555555555555';
const EPIC = 'epic-1';
const saved = {};
const tmpDirs = [];
let cwd;

beforeEach(async () => {
  for (const k of ['HOME', 'SM_AGENT_CLI_STATE_DIR']) saved[k] = process.env[k];
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-at-home-'));
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-at-state-'));
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-at-cwd-'));
  tmpDirs.push(home, state, cwd);
  process.env.HOME = home;
  process.env.SM_AGENT_CLI_STATE_DIR = state;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function writeIndex(rec) {
  fs.mkdirSync(path.dirname(activeIndexPath(cwd)), { recursive: true });
  fs.writeFileSync(activeIndexPath(cwd), JSON.stringify({ sessions: { [EPIC]: { id: EPIC, cwd, claudeSessionId: SID, ...rec } }, events: {}, tombstones: {} }));
}
function writeAgentTranscript(text) {
  const f = transcriptPathFor(SID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const claudeResolve = { resolvePath: () => path.join(cwd, 'no-such-claude.jsonl') };

test('non-Claude Epic (active index): gzips the agent-CLI transcript into the sidecar', () => {
  writeIndex({ agentCli: 'codex' });
  const text = '{"type":"user"}\n{"type":"assistant"}\n';
  writeAgentTranscript(text);
  const ptr = archiveTranscript({ cwd, epicId: EPIC, claudeSessionId: SID }, claudeResolve);
  expect(ptr).toMatchObject({ bytes: Buffer.byteLength(text) });
  expect(readSidecar(cwd, EPIC)).toBe(text);
});

test('non-Claude Epic known only via its status mirror still archives', () => {
  fs.mkdirSync(path.dirname(epicMirrorPath(cwd, EPIC)), { recursive: true });
  fs.writeFileSync(epicMirrorPath(cwd, EPIC), JSON.stringify({ session: { id: EPIC, agentCli: 'opencode' }, status: 'completed' }));
  writeAgentTranscript('{"a":1}\n');
  expect(archiveTranscript({ cwd, epicId: EPIC, claudeSessionId: SID }, claudeResolve)).not.toBeNull();
  expect(readSidecar(cwd, EPIC)).toBe('{"a":1}\n');
});

test('non-Claude Epic with no agent-CLI transcript returns null (durable-turn fallback)', () => {
  writeIndex({ agentCli: 'gemini' });
  expect(archiveTranscript({ cwd, epicId: EPIC, claudeSessionId: SID }, claudeResolve)).toBeNull();
  expect(readSidecar(cwd, EPIC)).toBeNull();
});

test('Claude Epic still reads the Claude JSONL, never the agent-CLI store', () => {
  writeIndex({});
  writeAgentTranscript('{"agent":1}\n');
  const claudeFile = path.join(cwd, 'claude.jsonl');
  fs.writeFileSync(claudeFile, '{"claude":1}\n');
  archiveTranscript({ cwd, epicId: EPIC, claudeSessionId: SID }, { resolvePath: () => claudeFile });
  expect(readSidecar(cwd, EPIC)).toBe('{"claude":1}\n');
});
