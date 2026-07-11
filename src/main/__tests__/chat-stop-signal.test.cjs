/**
 * chat-stop-signal.test.cjs — unit tests for chatRunner.parseStopSignal, the
 * single source of truth for the terminal-chat stop-signal protocol (PRD 318).
 *
 * Run: timeout 120 node --test src/main/__tests__/chat-stop-signal.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseStopSignal, STOP_SENTINEL } = require('../chatRunner.cjs');

test('sentinel present with valid JSON → questions array', () => {
  const text =
    'I did some work but need to know which target.\n' +
    `${STOP_SENTINEL}\n` +
    '{"questions":["Which environment?","Overwrite existing config?"]}';
  const out = parseStopSignal(text);
  assert.deepEqual(out, {
    questions: ['Which environment?', 'Overwrite existing config?'],
  });
});

test('sentinel absent → null (run is complete)', () => {
  const text = 'All done. I created the file and the tests pass.';
  assert.equal(parseStopSignal(text), null);
});

test('sentinel present but malformed JSON → null (treated as complete, no crash)', () => {
  const text = `Here is a summary.\n${STOP_SENTINEL}\n{questions: [oops not json}`;
  assert.equal(parseStopSignal(text), null);
});

test('sentinel present but JSON lacks questions array → null', () => {
  const text = `${STOP_SENTINEL}\n{"foo":"bar"}`;
  assert.equal(parseStopSignal(text), null);
});

test('non-string input → null (no crash)', () => {
  assert.equal(parseStopSignal(undefined), null);
  assert.equal(parseStopSignal(null), null);
  assert.equal(parseStopSignal(42), null);
});

test('only the LAST sentinel occurrence is parsed', () => {
  const text =
    `${STOP_SENTINEL}\n{"questions":["stale earlier block"]}\n` +
    'then the agent kept working...\n' +
    `${STOP_SENTINEL}\n{"questions":["the real question"]}`;
  assert.deepEqual(parseStopSignal(text), { questions: ['the real question'] });
});

test('blank lines between sentinel and JSON → questions array', () => {
  const text = `${STOP_SENTINEL}\n\n\n{"questions":["Which environment?"]}`;
  assert.deepEqual(parseStopSignal(text), { questions: ['Which environment?'] });
});

test('JSON wrapped in a ```json code fence → questions array', () => {
  const text =
    `${STOP_SENTINEL}\n` +
    '```json\n' +
    '{"questions":["Overwrite existing config?"]}\n' +
    '```';
  assert.deepEqual(parseStopSignal(text), { questions: ['Overwrite existing config?'] });
});

test('pretty-printed multi-line JSON → questions array', () => {
  const text =
    `${STOP_SENTINEL}\n` +
    '{\n' +
    '  "questions": [\n' +
    '    "Which environment?",\n' +
    '    "Overwrite existing config?"\n' +
    '  ]\n' +
    '}';
  assert.deepEqual(parseStopSignal(text), {
    questions: ['Which environment?', 'Overwrite existing config?'],
  });
});

test('trailing prose after the closing brace → questions array', () => {
  const text =
    `${STOP_SENTINEL}\n` +
    '{"questions":["Which environment?"]}\n' +
    '\n' +
    'Let me know and I will continue.';
  assert.deepEqual(parseStopSignal(text), { questions: ['Which environment?'] });
});
