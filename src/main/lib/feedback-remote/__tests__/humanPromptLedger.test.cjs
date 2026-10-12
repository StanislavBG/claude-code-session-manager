/**
 * humanPromptLedger.test.cjs — in-memory ledger of human-typed chat prompts.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/humanPromptLedger.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const ledger = require('../humanPromptLedger.cjs');

const HOUR = 60 * 60 * 1000;

beforeEach(() => ledger._resetForTests());

test('exact match returns text and timestamp', () => {
  ledger.recordHumanPrompt('s1', 'please send feedback to the billing project', 1000);
  expect(ledger.findHumanPromptContaining('s1', 'send feedback to the billing', 2000)).toEqual({
    text: 'please send feedback to the billing project',
    at: 1000,
  });
});

test('whitespace and case insensitive match', () => {
  ledger.recordHumanPrompt('s1', 'Please   SEND\n feedback\tto the Billing project', 1000);
  const hit = ledger.findHumanPromptContaining('s1', '  send FEEDBACK   to the billing  ', 1500);
  expect(hit).not.toBeNull();
  expect(hit.at).toBe(1000);
});

test('short quote rejected', () => {
  ledger.recordHumanPrompt('s1', 'a'.repeat(100), 1000);
  expect(ledger.MIN_QUOTE_CHARS).toBe(20);
  expect(ledger.findHumanPromptContaining('s1', 'a'.repeat(19), 1000)).toBeNull();
  expect(ledger.findHumanPromptContaining('s1', 'a'.repeat(20), 1000)).not.toBeNull();
});

test('wrong or unknown session rejected', () => {
  ledger.recordHumanPrompt('s1', 'please send feedback to the billing project', 1000);
  expect(ledger.findHumanPromptContaining('s2', 'send feedback to the billing', 1000)).toBeNull();
  expect(ledger.findHumanPromptContaining('s1', 'something never typed by anyone', 1000)).toBeNull();
});

test('entries expire after 24 hours', () => {
  ledger.recordHumanPrompt('s1', 'please send feedback to the billing project', 0);
  expect(ledger.findHumanPromptContaining('s1', 'send feedback to the billing', 23 * HOUR)).not.toBeNull();
  expect(ledger.findHumanPromptContaining('s1', 'send feedback to the billing', 25 * HOUR)).toBeNull();
  // pruned: still gone even when queried at an earlier clock
  expect(ledger.findHumanPromptContaining('s1', 'send feedback to the billing', 1000)).toBeNull();
});

test('per-session cap of 10 drops the oldest', () => {
  for (let i = 0; i < 11; i++) {
    ledger.recordHumanPrompt('s1', `prompt number ${String(i).padStart(2, '0')} with padding`, 1000 + i);
  }
  expect(ledger.findHumanPromptContaining('s1', 'prompt number 00 with padding', 2000)).toBeNull();
  expect(ledger.findHumanPromptContaining('s1', 'prompt number 01 with padding', 2000)).not.toBeNull();
  expect(ledger.findHumanPromptContaining('s1', 'prompt number 10 with padding', 2000)).not.toBeNull();
});

test('200-session cap evicts least-recently-recorded session', () => {
  for (let i = 0; i < 200; i++) ledger.recordHumanPrompt(`s${i}`, `session prompt text number ${i}`, 1000);
  // re-record s0 so s1 becomes least recent
  ledger.recordHumanPrompt('s0', 'session prompt text number 0 again', 1001);
  ledger.recordHumanPrompt('s200', 'session prompt text number 200', 1002);
  expect(ledger.findHumanPromptContaining('s1', 'session prompt text number 1', 1003)).toBeNull();
  expect(ledger.findHumanPromptContaining('s0', 'session prompt text number 0', 1003)).not.toBeNull();
  expect(ledger.findHumanPromptContaining('s200', 'session prompt text number 200', 1003)).not.toBeNull();
});

test('bad input is ignored and long text truncated', () => {
  expect(() => ledger.recordHumanPrompt(null, 'x'.repeat(30))).not.toThrow();
  expect(() => ledger.recordHumanPrompt('s1', 42)).not.toThrow();
  expect(() => ledger.recordHumanPrompt('s1', '')).not.toThrow();
  ledger.recordHumanPrompt('s1', 'y'.repeat(30000), 1000);
  const hit = ledger.findHumanPromptContaining('s1', 'y'.repeat(20), 1000);
  expect(hit.text.length).toBe(20000);
});
