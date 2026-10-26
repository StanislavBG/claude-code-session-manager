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
  CLASSIFY_PROMPT_PREFIX,
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

function stdinSink() {
  const { PassThrough } = require('node:stream');
  const stdin = new PassThrough();
  const chunks = [];
  const sink = { chunks, ended: false, stdin };
  stdin.on('data', (c) => chunks.push(c));
  stdin.on('end', () => { sink.ended = true; });
  return sink;
}

test('classifyPromptTicket spawns with a pinned model, argv array (no shell string), and the prompt on a stdin pipe', async () => {
  let capturedBin;
  let capturedArgs;
  let capturedOpts;
  const sink = stdinSink();
  __setSpawnForTest((bin, args, opts) => {
    capturedBin = bin;
    capturedArgs = args;
    capturedOpts = opts;
    const child = fakeChild();
    child.stdin = sink.stdin;
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('inline'));
      child.emit('close', 0);
    }, 0);
    return child;
  });

  await classifyPromptTicket('hello');
  await new Promise((r) => setTimeout(r, 20));

  expect(typeof capturedBin).toBe('string');
  expect(Array.isArray(capturedArgs)).toBe(true);
  expect(capturedArgs).toContain('--model');
  expect(capturedArgs[capturedArgs.indexOf('--model') + 1]).toBe('sonnet');
  expect(capturedArgs[capturedArgs.indexOf('-p') + 1]).toBe('--model');
  expect(capturedOpts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  expect(capturedOpts.shell).toBeFalsy();
  expect(Buffer.concat(sink.chunks).toString('utf8')).toBe(`${CLASSIFY_PROMPT_PREFIX}hello`);
  expect(sink.ended).toBe(true);
});

test('classifyPromptTicket tolerates a child without stdin', async () => {
  __setSpawnForTest(() => {
    const child = fakeChild();
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  });
  expect(await classifyPromptTicket('x')).toBe('inline');
});

test('a 300 KB ticket puts no argv element at or over the 128 KB E2BIG limit', async () => {
  let capturedArgs;
  const sink = stdinSink();
  __setSpawnForTest((bin, args) => {
    capturedArgs = args;
    const child = fakeChild();
    child.stdin = sink.stdin;
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  });
  const text = 'x'.repeat(300 * 1024);
  await classifyPromptTicket(text);
  await new Promise((r) => setTimeout(r, 20));
  for (const a of capturedArgs) expect(Buffer.byteLength(a)).toBeLessThan(131072);
  expect(Buffer.concat(sink.chunks).toString('utf8')).toBe(`${CLASSIFY_PROMPT_PREFIX}${text}`);
});
