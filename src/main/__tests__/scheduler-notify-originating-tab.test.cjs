/**
 * scheduler-notify-originating-tab.test.cjs — unit tests for
 * notifyOriginatingTab (PRD 761): on a job's terminal completed/failed
 * transition, push a short status prompt into the chat tab that originated
 * it via enqueueExternalPrompt (PRD 753).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-notify-originating-tab.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const { notifyOriginatingTab, isNotifiableTerminalStatus } = require('../scheduler.cjs');

test('isNotifiableTerminalStatus: completed and failed are notifiable', () => {
  expect(isNotifiableTerminalStatus('completed')).toBe(true);
  expect(isNotifiableTerminalStatus('failed')).toBe(true);
});

test('isNotifiableTerminalStatus: needs_review is not notifiable (may still auto-fix)', () => {
  expect(isNotifiableTerminalStatus('needs_review')).toBe(false);
});

test('isNotifiableTerminalStatus: a rateLimited exit never reaches an effectiveStatus (undefined) and is not notifiable', () => {
  // spawnJob's treatAsPending branch (rateLimited || paused for rate_limit)
  // resets the job to pending and returns before effectiveStatus is ever
  // computed — so this hook is only ever evaluated with undefined/pending,
  // never with a real status, on that path.
  expect(isNotifiableTerminalStatus(undefined)).toBe(false);
  expect(isNotifiableTerminalStatus('pending')).toBe(false);
});

test('resolves via sourceTabId when present on the PRD frontmatter', async () => {
  const sendPrompt = vi.fn();
  const parsePrdRaw = vi.fn(async () => ({ sourceTabId: 'tab-from-frontmatter' }));
  const loadSessions = vi.fn(async () => ({ tabs: [] }));

  await notifyOriginatingTab(
    { slug: '761-notify', status: 'completed', cwd: '/some/cwd' },
    { parsePrdRaw, loadSessions, sendPrompt },
  );

  expect(loadSessions).not.toHaveBeenCalled();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(sendPrompt).toHaveBeenCalledWith(
    'tab-from-frontmatter',
    expect.stringContaining('761-notify'),
  );
});

test('falls back to the first open tab whose cwd matches the job cwd', async () => {
  const sendPrompt = vi.fn();
  const parsePrdRaw = vi.fn(async () => ({ sourceTabId: null }));
  const loadSessions = vi.fn(async () => ({
    tabs: [
      { id: 'tab-other', cwd: '/other/cwd' },
      { id: 'tab-match', cwd: '/some/cwd' },
      { id: 'tab-second-match', cwd: '/some/cwd' },
    ],
  }));

  await notifyOriginatingTab(
    { slug: '761-notify', status: 'failed', cwd: '/some/cwd' },
    { parsePrdRaw, loadSessions, sendPrompt },
  );

  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(sendPrompt).toHaveBeenCalledWith('tab-match', expect.stringContaining('761-notify'));
});

test('no-ops without throwing when neither sourceTabId nor a cwd-matching tab resolves', async () => {
  const sendPrompt = vi.fn();
  const parsePrdRaw = vi.fn(async () => ({ sourceTabId: null }));
  const loadSessions = vi.fn(async () => ({ tabs: [{ id: 'tab-other', cwd: '/unrelated' }] }));

  await expect(
    notifyOriginatingTab(
      { slug: '761-notify', status: 'completed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt },
    ),
  ).resolves.not.toThrow();

  expect(sendPrompt).not.toHaveBeenCalled();
});

test('no-ops when parsing the PRD frontmatter throws', async () => {
  const sendPrompt = vi.fn();
  const parsePrdRaw = vi.fn(async () => { throw new Error('ENOENT'); });
  const loadSessions = vi.fn(async () => ({ tabs: [] }));

  await expect(
    notifyOriginatingTab(
      { slug: '761-notify', status: 'completed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt },
    ),
  ).resolves.not.toThrow();

  expect(sendPrompt).not.toHaveBeenCalled();
});
