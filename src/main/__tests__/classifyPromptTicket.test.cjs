/**
 * classifyPromptTicket.test.cjs — unit tests for the PromptTicket
 * inline-vs-develop classifier (PRD 749).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/classifyPromptTicket.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const { EventEmitter } = require('node:events');
const {
  classifyPromptTicket,
  parseVerdict,
  __setSpawnForTest,
} = require('../lib/classifyPromptTicket.cjs');

beforeEach(() => {
  __setSpawnForTest(null); // restore real spawn between tests
});

test('parseVerdict returns "develop" only when the raw text contains the word develop', () => {
  expect(parseVerdict('develop')).toBe('develop');
  expect(parseVerdict('  Develop  ')).toBe('develop');
  expect(parseVerdict('inline')).toBe('inline');
  expect(parseVerdict('')).toBe('inline');
  expect(parseVerdict(undefined)).toBe('inline');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('classifyPromptTicket resolves "develop" for a complex sample prompt (stubbed spawn)', async () => {
  __setSpawnForTest(() => {
    const child = fakeChild();
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('develop'));
      child.emit('close', 0);
    }, 0);
    return child;
  });

  const verdict = await classifyPromptTicket('Build a full multi-tab prompt-queue feature with PRD decomposition');
  expect(verdict).toBe('develop');
});

test('classifyPromptTicket resolves "inline" for a quick sample prompt (stubbed spawn)', async () => {
  __setSpawnForTest(() => {
    const child = fakeChild();
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('inline'));
      child.emit('close', 0);
    }, 0);
    return child;
  });

  const verdict = await classifyPromptTicket('what time is it');
  expect(verdict).toBe('inline');
});

test('classifyPromptTicket fails safe to "inline" when the child process errors', async () => {
  __setSpawnForTest(() => {
    const child = fakeChild();
    setTimeout(() => child.emit('error', new Error('spawn failed')), 0);
    return child;
  });

  const verdict = await classifyPromptTicket('anything');
  expect(verdict).toBe('inline');
});

test('classifyPromptTicket spawns with a pinned model, argv array (no shell string), and closed stdin', async () => {
  let capturedBin;
  let capturedArgs;
  let capturedOpts;
  __setSpawnForTest((bin, args, opts) => {
    capturedBin = bin;
    capturedArgs = args;
    capturedOpts = opts;
    const child = fakeChild();
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('inline'));
      child.emit('close', 0);
    }, 0);
    return child;
  });

  await classifyPromptTicket('hello');

  expect(typeof capturedBin).toBe('string');
  expect(Array.isArray(capturedArgs)).toBe(true);
  expect(capturedArgs).toContain('--model');
  expect(capturedArgs[capturedArgs.indexOf('--model') + 1]).toBe('sonnet');
  expect(capturedOpts.stdio[0]).toBe('ignore');
  expect(capturedOpts.shell).toBeFalsy();
});
