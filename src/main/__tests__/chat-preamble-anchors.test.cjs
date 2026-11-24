/**
 * chat-preamble-anchors.test.cjs — drift guard between chatRunner's injected
 * instruction blocks and the renderer's splitter that hides them.
 *
 * `src/renderer/lib/promptPreamble.ts` anchors each block on its FIRST and
 * LAST sentence only, because it cannot import this main-process .cjs. That
 * indirection is safe ONLY while those anchors still bracket the real text —
 * so this test composes the exact `fullPrompt` chatRunner builds and asserts
 * the splitter recovers the human's words exactly. Reword either block's
 * opening or closing sentence and this fails here, loudly, instead of the
 * boilerplate silently reappearing in every user bubble.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/chat-preamble-anchors.test.cjs
 */

'use strict';

const path = require('path');

import { test, expect } from 'vitest';

const {
  STOP_SIGNAL_INSTRUCTION,
  CHAT_MODE_TRUTH_INSTRUCTION,
  SCHEDULER_TURN_INSTRUCTION,
  STOP_SENTINEL,
  turnInstructionFor,
} = require('../chatRunner.cjs');
const { autoStartTurnInstruction } = require('../lib/feedback-remote/autoStartedSession.cjs');

const HUMAN = 'Review the Alpaca limits and report back what we can trade for free.';

async function loadSplitter() {
  const mod = await import(
    /* @vite-ignore */ path.resolve(__dirname, '..', '..', 'renderer', 'lib', 'promptPreamble.ts')
  );
  return mod;
}

test('the real fullPrompt splits back into exactly the human’s words', async () => {
  const { splitInjectedPreamble } = await loadSplitter();
  // Mirrors chatRunner's own composition at its `-p` call site.
  const fullPrompt = STOP_SIGNAL_INSTRUCTION + CHAT_MODE_TRUTH_INSTRUCTION + HUMAN;

  const split = splitInjectedPreamble(fullPrompt);
  expect(split.body).toBe(HUMAN);
  expect(split.blockKeys).toEqual(['stop-signal', 'chat-mode-truth']);
  expect(split.preamble).toBeTruthy();
  // Nothing is invented or lost: preamble + body reconstitute the input.
  expect(split.preamble.length + split.body.length).toBeLessThanOrEqual(fullPrompt.length);
  expect(fullPrompt.startsWith(split.preamble)).toBe(true);
  expect(fullPrompt.endsWith(split.body)).toBe(true);
});

test('each block strips independently, so one being absent still works', async () => {
  const { splitInjectedPreamble } = await loadSplitter();

  const onlyStop = splitInjectedPreamble(STOP_SIGNAL_INSTRUCTION + HUMAN);
  expect(onlyStop.body).toBe(HUMAN);
  expect(onlyStop.blockKeys).toEqual(['stop-signal']);

  const onlyTruth = splitInjectedPreamble(CHAT_MODE_TRUTH_INSTRUCTION + HUMAN);
  expect(onlyTruth.body).toBe(HUMAN);
  expect(onlyTruth.blockKeys).toEqual(['chat-mode-truth']);
});

test('a prompt with no injected blocks is returned untouched', async () => {
  const { splitInjectedPreamble } = await loadSplitter();
  const split = splitInjectedPreamble(HUMAN);
  expect(split.preamble).toBe(null);
  expect(split.body).toBe(HUMAN);
  expect(split.blockKeys).toEqual([]);
});

test('EDGE: a boilerplate-only prompt is NOT stripped to an empty bubble', async () => {
  const { splitInjectedPreamble } = await loadSplitter();
  const onlyBoilerplate = STOP_SIGNAL_INSTRUCTION + CHAT_MODE_TRUTH_INSTRUCTION;
  const split = splitInjectedPreamble(onlyBoilerplate);
  expect(split.preamble).toBe(null);
  expect(split.body).toBe(onlyBoilerplate);
});

test('EDGE: a truncated block (opening present, closing missing) is left fully intact', async () => {
  const { splitInjectedPreamble } = await loadSplitter();
  // Simulates a reworded/cut-off block: better to over-show boilerplate than
  // to guess at a boundary and eat the human's words.
  const truncated = `${STOP_SIGNAL_INSTRUCTION.slice(0, 120)}\n\n${HUMAN}`;
  const split = splitInjectedPreamble(truncated);
  expect(split.preamble).toBe(null);
  expect(split.body).toBe(truncated);
});

test('the two blocks strip in either order', async () => {
  const { splitInjectedPreamble } = await loadSplitter();
  const reversed = CHAT_MODE_TRUTH_INSTRUCTION + STOP_SIGNAL_INSTRUCTION + HUMAN;
  const split = splitInjectedPreamble(reversed);
  expect(split.body).toBe(HUMAN);
  expect(split.blockKeys).toEqual(['chat-mode-truth', 'stop-signal']);
});

test('EDGE: boilerplate quoted inside the human’s own message is never stripped', async () => {
  const { splitInjectedPreamble } = await loadSplitter();
  const quoting = `Why does chat prepend this?\n\n${STOP_SIGNAL_INSTRUCTION}`;
  const split = splitInjectedPreamble(quoting);
  expect(split.preamble).toBe(null);
  expect(split.body).toBe(quoting);
});

test('a scheduler check-in turn splits back into the human’s words', async () => {
  const { splitInjectedPreamble, MACHINE_TURN_BLOCK_KEYS } = await loadSplitter();
  const split = splitInjectedPreamble(SCHEDULER_TURN_INSTRUCTION + CHAT_MODE_TRUTH_INSTRUCTION + HUMAN);
  expect(split.body).toBe(HUMAN);
  expect(split.blockKeys).toEqual(['scheduler-turn', 'chat-mode-truth']);
  expect(MACHINE_TURN_BLOCK_KEYS).toEqual(['scheduler-turn', 'auto-start-turn']);
});

test('an auto-started Epic turn splits back into the human’s words', async () => {
  const { splitInjectedPreamble } = await loadSplitter();
  const split = splitInjectedPreamble(
    autoStartTurnInstruction(STOP_SENTINEL) + CHAT_MODE_TRUTH_INSTRUCTION + HUMAN,
  );
  expect(split.body).toBe(HUMAN);
  expect(split.blockKeys).toEqual(['auto-start-turn', 'chat-mode-truth']);
});

test('composed turn prompts queue what remains instead of listing it', () => {
  const os = require('os');
  const cwd = os.tmpdir();
  const sid = 'no-such-epic-preamble-anchors';
  // Mirrors chatRunner's own composition at its `-p` call site.
  const chat = turnInstructionFor('manual', cwd, sid) + CHAT_MODE_TRUTH_INSTRUCTION + HUMAN;
  const sched = turnInstructionFor('scheduler', cwd, sid) + CHAT_MODE_TRUTH_INSTRUCTION + HUMAN;

  const oneShot = 'do the part that fits, report exactly what landed, and queue or schedule what ' +
    'remains; only a step that needs the human goes back to them.';
  const schedLine = 'Give everything left open an outcome (queue, decide, schedule or close it), ' +
    'and end with a short report of what you did.';

  expect(chat).toContain(oneShot);
  expect(sched).toContain(oneShot);
  expect(sched).toContain(schedLine);
  expect(chat).toContain('Otherwise complete the task and end with a concise summary of what you did.');
  for (const p of [chat, sched]) {
    expect(p).not.toContain('say what remains');
    expect(p).not.toContain('Make the safest reasonable choice');
  }
});
