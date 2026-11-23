/**
 * chatRunner-needs-input-event.test.cjs — an Epic chat turn that ends on the
 * stop signal appends job.needs_input (Epic-level, the parsed questions) to
 * the Epic event log, and the next human-sent prompt on that session appends
 * human.answer. Drives the REAL spawn path via a stub `claude`.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/chatRunner-needs-input-event.test.cjs
 */

'use strict';

delete process.env.SM_CHAT_CONCURRENCY;

import { test, expect, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STOP = '<<<SM_NEEDS_INPUT>>>';
const finalText = `Did the part I could.\n${STOP}\n{"questions":["Which environment?","Overwrite config?"]}`;
const stubPath = require('../../../tests/helpers/claudeStub.cjs').writeClaudeStub({
  body: `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(finalText)} }) + '\\n');\nprocess.exit(0);`,
});
process.env.SM_CLAUDE_BIN = stubPath;

const cr = require('../chatRunner.cjs');
const { readEpicEvents } = require('../lib/epic/epicEventLog.cjs');

const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chat-needs-input-'));
const EPIC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

afterAll(() => {
  cr.__resetQueueForTests();
  fs.rmSync(scratchCwd, { recursive: true, force: true });
});

async function waitFor(fn, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test('stop-signal turn appends job.needs_input; the next human prompt appends human.answer', async () => {
  const sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });

  cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'do the thing', cwd: scratchCwd, resume: false });

  const needs = await waitFor(async () => {
    const { events } = await readEpicEvents(scratchCwd, EPIC, { kinds: ['job.needs_input'] });
    return events.length ? events : null;
  });
  expect(sent.some((e) => e.channel === 'chat:run:needs-input')).toBe(true);
  expect(needs).toHaveLength(1);
  expect(needs[0]).toMatchObject({ kind: 'job.needs_input', source: 'chat', sessionId: EPIC, questions: ['Which environment?', 'Overwrite config?'] });
  expect(needs[0].slug).toBeUndefined();

  // Let the first run settle before the answer turn.
  await waitFor(() => sent.some((e) => e.channel === 'chat:run:needs-input'));
  await new Promise((r) => setTimeout(r, 100));

  cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'staging, and yes', cwd: scratchCwd, resume: true, origin: 'human' });
  const answers = await waitFor(async () => {
    const { events } = await readEpicEvents(scratchCwd, EPIC, { kinds: ['human.answer'] });
    return events.length ? events : null;
  });
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ kind: 'human.answer', sessionId: EPIC, answer: 'staging, and yes', questions: ['Which environment?', 'Overwrite config?'] });
  await waitFor(() => sent.filter((e) => e.channel === 'chat:run:needs-input').length >= 2);
});

test('a scheduler-originated prompt is not an answer; no open question → no human.answer', async () => {
  cr.__resetQueueForTests();
  const cwd = fs.mkdtempSync(path.join(scratchCwd, 'b-'));
  const epic = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  expect(cr.recordAnswerIfOpen({ cwd, sessionId: epic, prompt: 'hi' })).toBeNull();
  await cr.recordNeedsInput({ cwd, sessionId: epic, questions: ['Q?'] });
  expect(cr.recordAnswerIfOpen({ cwd, sessionId: epic, prompt: 'notice', origin: 'scheduler' })).toBeNull();
  await cr.recordAnswerIfOpen({ cwd, sessionId: epic, prompt: 'A' });
  const { events } = await readEpicEvents(cwd, epic);
  expect(events.map((e) => e.kind)).toEqual(['job.needs_input', 'human.answer']);
});
