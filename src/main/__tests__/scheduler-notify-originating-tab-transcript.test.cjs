/**
 * scheduler-notify-originating-tab-transcript.test.cjs — unit tests for the
 * PRD 863 addition to notifyOriginatingTab: persisting the job's real
 * result text (read from the run's log) to the durable per-Epic transcript
 * store, independent of the existing short-status-chip notification.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-notify-originating-tab-transcript.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const { notifyOriginatingTab, extractResultTextFromLog } = require('../scheduler.cjs');

test('extractResultTextFromLog returns null for a missing log path', () => {
  expect(extractResultTextFromLog(null)).toBeNull();
  expect(extractResultTextFromLog('/does/not/exist.log')).toBeNull();
});

test('appends the job result text to the transcript store when sourcePromptId is known', async () => {
  const appendTranscriptTurn = vi.fn(async () => true);
  const readResultFromLog = vi.fn(() => 'the real agent result text');
  const appendResponseEvent = vi.fn(async () => true);
  const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

  await notifyOriginatingTab(
    { slug: '863-transcript', status: 'completed', cwd: '/some/cwd', runId: 'run-1' },
    { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
  );

  expect(appendTranscriptTurn).toHaveBeenCalledTimes(1);
  expect(appendTranscriptTurn).toHaveBeenCalledWith('/some/cwd', 'psess-abc', {
    role: 'assistant',
    text: 'the real agent result text',
  });
});

test('falls back to the short status message when the run log has no result text', async () => {
  const appendTranscriptTurn = vi.fn(async () => true);
  const readResultFromLog = vi.fn(() => null);
  const appendResponseEvent = vi.fn(async () => true);
  const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

  await notifyOriginatingTab(
    { slug: '863-fallback', status: 'completed', cwd: '/some/cwd', runId: 'run-1' },
    { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
  );

  expect(appendTranscriptTurn).toHaveBeenCalledWith(
    '/some/cwd',
    'psess-abc',
    expect.objectContaining({ text: expect.stringContaining('863-fallback') }),
  );
});

test('a throwing transcript append never breaks the existing notification path', async () => {
  const appendTranscriptTurn = vi.fn(async () => {
    throw new Error('disk full');
  });
  const readResultFromLog = vi.fn(() => 'result text');
  const appendResponseEvent = vi.fn(async () => true);
  const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

  await expect(
    notifyOriginatingTab(
      { slug: '863-safe', status: 'completed', cwd: '/some/cwd', runId: 'run-1' },
      { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
    ),
  ).resolves.toBeUndefined();

  expect(appendResponseEvent).toHaveBeenCalledTimes(1);
});

test('no cwd on the job skips the transcript append but does not throw', async () => {
  const appendTranscriptTurn = vi.fn(async () => true);
  const readResultFromLog = vi.fn(() => 'result text');
  const appendResponseEvent = vi.fn(async () => true);
  const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

  await notifyOriginatingTab(
    { slug: '863-nocwd', status: 'completed', cwd: null, runId: 'run-1' },
    { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
  );

  expect(appendTranscriptTurn).not.toHaveBeenCalled();
});
