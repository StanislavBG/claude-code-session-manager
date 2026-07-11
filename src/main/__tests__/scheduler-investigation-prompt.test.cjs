/**
 * scheduler-investigation-prompt.test.cjs — unit tests for buildInvestigationPrompt.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-investigation-prompt.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInvestigationPrompt } = require('../scheduler.cjs');

function makeArgs(overrides = {}) {
  return {
    failedJob: { slug: '05-my-feature', title: 'My feature', exitCode: 1 },
    cwd: '/home/bilko/Projects/session-manager',
    failedLogPath: '/tmp/05-my-feature.log',
    originalBody: 'Original PRD body.',
    logTail: 'some log tail output',
    fixPath: '/tmp/05-fix-my-feature.md',
    group: 5,
    ...overrides,
  };
}

test('prompt references the canonical standards.md file', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /standards\.md/);
  assert.match(prompt, /plugins\/session-manager-dev\/skills\/develop\/standards\.md/);
});

test('prompt instructs inlining the Execution discipline section under Engineering standards', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /Engineering standards/);
  assert.match(prompt, /Execution discipline \(headless runs\)/);
});

test('prompt contains the named "delegated instead of executed" detection check', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /ScheduleWakeup/);
  assert.match(prompt, /session-manager-dev:develop/);
  assert.match(prompt, /never re-queue or self-schedule|delegated instead of executed/);
});

test('prompt includes the resolved job fields', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /05-my-feature/);
  assert.match(prompt, /Original PRD body\./);
  assert.match(prompt, /some log tail output/);
  assert.match(prompt, /05-fix-my-feature\.md/);
});
