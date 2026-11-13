/**
 * transcripts-agent-cli-path.test.cjs — a non-Claude (agent-CLI) Epic's turns are
 * written to agentCliSessionStore.transcriptPathFor(id); transcripts.cjs must
 * resolve that file when it exists, and fall back to the Claude path otherwise.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/transcripts-agent-cli-path.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
let tmpHome;
let stateDir;
let originalHome;
let originalState;
let tr;
let store;
let encodeCwd;
const CWD = '/tmp/sm-agent-cli-path-test-project';

beforeAll(() => {
  originalHome = process.env.HOME;
  originalState = process.env.SM_AGENT_CLI_STATE_DIR;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-agent-cli-home-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-agent-cli-state-'));
  process.env.HOME = tmpHome;
  process.env.SM_AGENT_CLI_STATE_DIR = stateDir;
  tr = require('../transcripts.cjs');
  store = require('../lib/agent-cli/agentCliSessionStore.cjs');
  ({ encodeCwd } = require('../lib/util/encodeCwd.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalState === undefined) delete process.env.SM_AGENT_CLI_STATE_DIR;
  else process.env.SM_AGENT_CLI_STATE_DIR = originalState;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(stateDir, 'transcripts'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
});

const claudePath = () => path.join(tmpHome, '.claude', 'projects', encodeCwd(CWD), `${SID}.jsonl`);

function writeAgentFile(lines) {
  const file = store.transcriptPathFor(SID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('resolves to the agent-CLI transcript when it exists', () => {
  const file = writeAgentFile([{ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: SID }]);
  expect(file.startsWith(stateDir)).toBe(true);
  expect(tr.transcriptPath(CWD, SID)).toBe(file);
  expect(tr.transcriptExists(CWD, SID)).toBe(true);
});

test('falls back to the Claude path when no agent-CLI file exists', () => {
  expect(tr.transcriptPath(CWD, SID)).toBe(claudePath());
  expect(tr.transcriptExists(CWD, SID)).toBe(false);
  fs.mkdirSync(path.dirname(claudePath()), { recursive: true });
  fs.writeFileSync(claudePath(), '');
  expect(tr.transcriptExists(CWD, SID)).toBe(true);
});

test('usageFor sums a usage-only line from the agent-CLI transcript', async () => {
  writeAgentFile([
    { type: 'user', message: { role: 'user', content: 'go' }, sessionId: SID },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, sessionId: SID },
    { type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 120, output_tokens: 34 } }, sessionId: SID },
  ]);
  const out = await tr.usageFor(CWD, [SID]);
  expect(out[SID]).toEqual({ inputTokens: 120, outputTokens: 34 });
});

test('an invalid (non-UUID) session id never throws and keeps the Claude path', () => {
  expect(() => tr.transcriptPath(CWD, 'not-a-uuid')).not.toThrow();
  expect(tr.transcriptPath(CWD, 'not-a-uuid')).toBe(
    path.join(tmpHome, '.claude', 'projects', encodeCwd(CWD), 'not-a-uuid.jsonl'),
  );
  expect(() => tr.transcriptExists(CWD, 'not-a-uuid')).not.toThrow();
});
