'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/remoteTranscriptTail-agent-cli.test.cjs
// Non-Claude (agent-CLI) Epics write their turns to agentCliSessionStore's
// transcript, not ~/.claude/projects; the phone tail must read that file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
import { describe, it, beforeEach, afterEach } from 'vitest';
const { readRecentChatMessages, agentCliTranscriptPath } = require('../remoteTranscriptTail.cjs');
const { transcriptPathFor } = require('../agent-cli/agentCliSessionStore.cjs');

const ID = '0b6f2a3c-1d4e-4f5a-8b9c-0d1e2f3a4b5c';
const line = (type, text) =>
  JSON.stringify({ type, message: { role: type, content: [{ type: 'text', text }] }, uuid: `${type}-${text}`, timestamp: '2026-11-13T00:00:00Z' }) + '\n';

describe('readRecentChatMessages — agent-CLI transcript', () => {
  let tmp;
  let saved;
  let claudeFile;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-agent-cli-'));
    saved = { HOME: process.env.HOME, SM_AGENT_CLI_STATE_DIR: process.env.SM_AGENT_CLI_STATE_DIR };
    process.env.HOME = path.join(tmp, 'home');
    process.env.SM_AGENT_CLI_STATE_DIR = path.join(tmp, 'agent-cli');
    claudeFile = path.join(process.env.HOME, '.claude', 'projects', '-proj', `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, line('user', 'claude prompt') + line('assistant', 'claude reply'));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the agent-CLI transcript when it exists', async () => {
    const agentFile = transcriptPathFor(ID);
    assert.ok(agentFile.startsWith(process.env.SM_AGENT_CLI_STATE_DIR));
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, line('user', 'codex prompt') + line('assistant', 'codex reply'));
    assert.equal(agentCliTranscriptPath(ID), agentFile);
    const msgs = await readRecentChatMessages(claudeFile, { claudeSessionId: ID });
    assert.deepEqual(msgs.map((m) => m.text), ['codex prompt', 'codex reply']);
  });

  it('falls back to the Claude path when no agent-CLI transcript exists', async () => {
    assert.equal(agentCliTranscriptPath(ID), null);
    const msgs = await readRecentChatMessages(claudeFile, { claudeSessionId: ID });
    assert.deepEqual(msgs.map((m) => m.text), ['claude prompt', 'claude reply']);
    // No session id at all → exactly today's behavior.
    const plain = await readRecentChatMessages(claudeFile);
    assert.deepEqual(plain.map((m) => m.text), ['claude prompt', 'claude reply']);
  });

  it('a non-UUID session id never throws and is treated as no agent-CLI file', async () => {
    for (const bad of ['not-a-uuid', '../../etc/passwd', '', null, 42]) {
      assert.equal(agentCliTranscriptPath(bad), null);
      const msgs = await readRecentChatMessages(claudeFile, { claudeSessionId: bad });
      assert.deepEqual(msgs.map((m) => m.text), ['claude prompt', 'claude reply']);
    }
  });
});
