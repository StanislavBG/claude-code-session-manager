/**
 * chat-mcp-consent-notice.test.cjs — regression for the headless MCP-consent
 * hang: a chat run with stdin closed can never answer an MCP server's own
 * interactive consent flow (e.g. `/design consent`). This drives the real
 * stdout parser with a synthetic stream-json `tool_result` denial line and
 * asserts a `chat:run:notice` event is broadcast — informational, not a
 * terminal event.
 *
 * Run: timeout 120 node --test src/main/__tests__/chat-mcp-consent-notice.test.cjs
 */

'use strict';

delete process.env.SM_CHAT_CONCURRENCY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function writeStub(lines) {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = lines.map((l) => `process.stdout.write(${JSON.stringify(JSON.stringify(l))} + "\\n");`).join('\n');
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\nprocess.exit(0);\n`, { mode: 0o755 });
  return stubPath;
}

function isTerminal(channel) {
  return (
    channel === 'chat:run:complete' ||
    channel === 'chat:run:needs-input' ||
    channel === 'chat:run:error'
  );
}

test('MCP consent denial in a tool_result surfaces a chat:run:notice event', async () => {
  const stubPath = writeStub([
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: [
              {
                type: 'text',
                text:
                  "Claude Design: write_files The user hasn't granted this — run /design consent " +
                  "to grant it (it can't be approved automatically in this permission mode).",
              },
            ],
          },
        ],
      },
    },
    { type: 'result', subtype: 'success', result: 'done anyway' },
  ]);
  process.env.SM_CLAUDE_BIN = stubPath;
  delete require.cache[require.resolve('../chatRunner.cjs')];
  const cr = require('../chatRunner.cjs');

  const events = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload }),
    },
  });

  cr.run({ tabId: 'T-notice', sessionId: 'S-notice', prompt: 'do a design thing', cwd: process.cwd(), resume: false });

  for (let i = 0; i < 60 && !events.some((e) => isTerminal(e.channel)); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const notice = events.find((e) => e.channel === 'chat:run:notice');
  assert.ok(notice, 'chat:run:notice should be broadcast');
  assert.match(notice.payload.message, /consent/i, 'message mentions consent');
  assert.match(notice.payload.message, /terminal/i, 'message mentions the raw terminal session');

  // Notice is informational, not terminal — the normal result still fires.
  const terminal = events.filter((e) => isTerminal(e.channel));
  assert.equal(terminal.length, 1, 'exactly one terminal event still fires');
  assert.equal(terminal[0].channel, 'chat:run:complete');

  try { fs.unlinkSync(stubPath); } catch { /* already gone */ }
  delete process.env.SM_CLAUDE_BIN;
});

test('a normal tool_result with no consent marker does not fire chat:run:notice', async () => {
  const stubPath = writeStub([
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            is_error: false,
            content: [{ type: 'text', text: 'Wrote 3 files successfully.' }],
          },
        ],
      },
    },
    { type: 'result', subtype: 'success', result: 'all good' },
  ]);
  process.env.SM_CLAUDE_BIN = stubPath;
  delete require.cache[require.resolve('../chatRunner.cjs')];
  const cr = require('../chatRunner.cjs');

  const events = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload }),
    },
  });

  cr.run({ tabId: 'T-clean', sessionId: 'S-clean', prompt: 'do a normal thing', cwd: process.cwd(), resume: false });

  for (let i = 0; i < 60 && !events.some((e) => isTerminal(e.channel)); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.ok(
    !events.some((e) => e.channel === 'chat:run:notice'),
    'no chat:run:notice should fire for a clean tool_result (no false positive)',
  );

  try { fs.unlinkSync(stubPath); } catch { /* already gone */ }
  delete process.env.SM_CLAUDE_BIN;
});
