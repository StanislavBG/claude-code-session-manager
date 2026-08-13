/**
 * stop-signal-anchor.test.cjs — drift guard between chatRunner's
 * STOP_SENTINEL/splitStopSignal and the renderer's duplicated copy.
 *
 * `src/renderer/lib/stopSignal.ts` cannot import this main-process `.cjs`
 * (CommonJS main / ESM renderer split), so it carries its own literal
 * `STOP_SENTINEL` + a re-implementation of `splitStopSignal`. This test
 * requires the REAL exported constant and asserts the renderer's copy is
 * byte-identical, and that both splitters agree on `body` for the same
 * composed sample — so a rework of either constant/function fails here
 * loudly instead of the two forms of a stop-signal reply silently drifting
 * back out of sync (which is exactly what caused the doubled-message bug
 * this module exists to fix).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/stop-signal-anchor.test.cjs
 */

'use strict';

const path = require('path');

import { test, expect } from 'vitest';

const { STOP_SENTINEL, splitStopSignal } = require('../chatRunner.cjs');

async function loadRendererCopy() {
  const mod = await import(
    /* @vite-ignore */ path.resolve(__dirname, '..', '..', 'renderer', 'lib', 'stopSignal.ts')
  );
  return mod;
}

test('the renderer STOP_SENTINEL literal is byte-identical to chatRunner.cjs', async () => {
  const rendererCopy = await loadRendererCopy();
  expect(rendererCopy.STOP_SENTINEL).toBe(STOP_SENTINEL);
});

test('both splitters agree on body for a composed stop-signal reply', async () => {
  const rendererCopy = await loadRendererCopy();
  const body = 'Here is what I found and what I still need from you.';
  const full = `${body}\n\n${STOP_SENTINEL}\n${JSON.stringify({ questions: ['Deploy to prod now?'] })}`;

  const mainSplit = splitStopSignal(full);
  const rendererSplit = rendererCopy.splitStopSignal(full);

  expect(mainSplit).not.toBeNull();
  expect(rendererSplit).not.toBeNull();
  expect(rendererSplit.body).toBe(mainSplit.answerBody);
  expect(rendererSplit.body).toBe(body);
  expect(rendererSplit.questions ?? mainSplit.questions).toBeDefined();
});

test('both splitters return null for text with no sentinel', async () => {
  const rendererCopy = await loadRendererCopy();
  const plain = 'Just a normal reply, no protocol block.';
  expect(splitStopSignal(plain)).toBeNull();
  expect(rendererCopy.splitStopSignal(plain)).toBeNull();
});

test('both splitters refuse a quoted sentinel with no valid JSON tail', async () => {
  const rendererCopy = await loadRendererCopy();
  const quoting = `Why does chat use ${STOP_SENTINEL} internally? Not real JSON after it.`;
  expect(splitStopSignal(quoting)).toBeNull();
  expect(rendererCopy.splitStopSignal(quoting)).toBeNull();
});

test('both splitters anchor on the LAST sentinel occurrence', async () => {
  const rendererCopy = await loadRendererCopy();
  const body = 'first mention of the sentinel text, then the real one';
  const full = `${STOP_SENTINEL} mentioned earlier in prose.\n\n${body}\n\n${STOP_SENTINEL}\n${JSON.stringify({ questions: ['q'] })}`;

  const mainSplit = splitStopSignal(full);
  const rendererSplit = rendererCopy.splitStopSignal(full);
  expect(mainSplit.answerBody).toBe(rendererSplit.body);
});
