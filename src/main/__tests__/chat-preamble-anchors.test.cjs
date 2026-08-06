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

const { STOP_SIGNAL_INSTRUCTION, CHAT_MODE_TRUTH_INSTRUCTION } = require('../chatRunner.cjs');

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
