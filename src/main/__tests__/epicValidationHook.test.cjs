/**
 * epicValidationHook.test.cjs — PRD 986: a PRD check-in triggers validation
 * in the authoring Epic; it never asserts the PRD is done.
 *
 * Covers the PRD's five required cases:
 *   (a) a completed check-in enqueues exactly one validation prompt naming
 *       the PRD slug;
 *   (b) a check-in for a non-active Epic enqueues nothing;
 *   (c) a second check-in for the same (epicId, prdSlug) enqueues nothing;
 *   (d) the enqueued prompt contains the PRD's absolute path and the
 *       VERIFIED/REFUTED instruction (plus the not-evidence warning and the
 *       git diff --stat / empty-diff-is-REFUTED rule);
 *   (e) LOOP GUARD — an appended event that is a validation result never
 *       enqueues a further prompt.
 * Plus: the SM_EPIC_VALIDATION_DISABLE kill-switch, the born-'unvalidated'
 * stamp, and end-to-end wiring through notifyOriginatingTab.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/epicValidationHook.test.cjs
 */

'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
const {
  maybeEnqueueValidationPrompt,
  buildValidationPrompt,
  __resetForTests,
} = require('../lib/epicValidationHook.cjs');
const { notifyOriginatingTab } = require('../scheduler.cjs');

const EPIC = 'epic-986';
const SLUG = '986-example-prd';
const PRD_PATH = '/abs/path/to/session-manager-operations/scheduler/epics/epic-986/prds-archived/986-example-prd.md';

/** An active-index snapshot AS IT LOOKS RIGHT AFTER the scheduler's check-in
 *  append: exactly one validation-stamped response event for this prdSlug. */
function indexAfterCheckin({ status = 'active', extraEvents = [] } = {}) {
  return {
    sessions: { [EPIC]: { id: EPIC, status } },
    events: {
      [EPIC]: [
        { id: 'e1', promptSessionId: EPIC, kind: 'prompt', causedByEventId: null, at: '2026-08-02T00:00:00Z', text: 'goal' },
        {
          id: 'e2', promptSessionId: EPIC, kind: 'response', causedByEventId: 'e1',
          at: '2026-08-02T01:00:00Z', text: `PRD ${SLUG} finished: completed.`,
          prdSlug: SLUG, outcome: 'completed', validation: 'unvalidated',
        },
        ...extraEvents,
      ],
    },
  };
}

function callArgs(overrides = {}) {
  return {
    cwd: '/some/cwd',
    epicId: EPIC,
    prdSlug: SLUG,
    prdPath: PRD_PATH,
    outcome: 'completed',
    eventValidation: 'unvalidated',
    ...overrides,
  };
}

beforeEach(() => {
  __resetForTests();
  delete process.env.SM_EPIC_VALIDATION_DISABLE;
});

afterEach(() => {
  delete process.env.SM_EPIC_VALIDATION_DISABLE;
});

// ─── (a) completed check-in → exactly one prompt naming the slug ────────────

test('(a) a completed check-in enqueues exactly one validation prompt naming the PRD slug', () => {
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => indexAfterCheckin());

  const res = maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex });

  expect(res.enqueued).toBe(true);
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(sendPrompt).toHaveBeenCalledWith(EPIC, expect.stringContaining(SLUG));
});

// ─── (b) non-active Epic → nothing ──────────────────────────────────────────

test('(b) a check-in for a completed (non-active) Epic enqueues nothing', () => {
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => indexAfterCheckin({ status: 'completed' }));

  const res = maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex });

  expect(res).toEqual({ enqueued: false, reason: 'epic-not-active' });
  expect(sendPrompt).not.toHaveBeenCalled();
});

test('(b) an unknown Epic (no active-index entry) enqueues nothing — join-only, never creates an Epic', () => {
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => ({ sessions: {}, events: {} }));

  const res = maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex });

  expect(res).toEqual({ enqueued: false, reason: 'epic-not-active' });
  expect(sendPrompt).not.toHaveBeenCalled();
});

// ─── (c) second check-in for the same (epicId, prdSlug) → nothing ───────────

test('(c) a second check-in for the same (epicId, prdSlug) enqueues nothing (in-memory guard)', () => {
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => indexAfterCheckin());

  expect(maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex }).enqueued).toBe(true);
  const second = maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex });

  expect(second).toEqual({ enqueued: false, reason: 'already-fired' });
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

test('(c) durable guard: two validation-stamped check-in events already on the chain skip even after a process restart emptied the in-memory set', () => {
  const sendPrompt = vi.fn();
  // Chain carries the current check-in PLUS an earlier one for the same slug
  // (a re-notify after restart appends a second response event).
  const readActiveIndex = vi.fn(() => indexAfterCheckin({
    extraEvents: [{
      id: 'e3', promptSessionId: EPIC, kind: 'response', causedByEventId: 'e2',
      at: '2026-08-02T02:00:00Z', text: `PRD ${SLUG} finished: completed.`,
      prdSlug: SLUG, outcome: 'completed', validation: 'unvalidated',
    }],
  }));

  __resetForTests(); // simulate the restart: in-memory set is empty
  const res = maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex });

  expect(res).toEqual({ enqueued: false, reason: 'already-fired-durable' });
  expect(sendPrompt).not.toHaveBeenCalled();
});

test('(c) a different PRD slug for the same Epic still fires — the guard is per (epicId, prdSlug) pair, not per Epic', () => {
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => indexAfterCheckin());

  expect(maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex }).enqueued).toBe(true);
  const other = maybeEnqueueValidationPrompt(
    callArgs({ prdSlug: '987-other-prd', prdPath: '/abs/987-other-prd.md' }),
    { sendPrompt, readActiveIndex: vi.fn(() => ({ sessions: { [EPIC]: { id: EPIC, status: 'active' } }, events: { [EPIC]: [{ id: 'x', kind: 'response', prdSlug: '987-other-prd', validation: 'unvalidated' }] } })) },
  );

  expect(other.enqueued).toBe(true);
  expect(sendPrompt).toHaveBeenCalledTimes(2);
});

// ─── (d) prompt content ─────────────────────────────────────────────────────

test('(d) the enqueued prompt contains the PRD absolute path, the unverified-claim label, and the VERIFIED/REFUTED instruction', () => {
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => indexAfterCheckin());

  maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex });

  const prompt = sendPrompt.mock.calls[0][1];
  expect(prompt).toContain(PRD_PATH);
  expect(prompt).toContain(SLUG);
  expect(prompt).toContain('UNVERIFIED CLAIM');
  expect(prompt).toContain('"completed"');
  expect(prompt).toContain('VERIFIED or REFUTED');
  expect(prompt).toMatch(/file:line|command output/);
  // AC #3: the not-evidence warning + the git diff --stat / empty-diff rule.
  expect(prompt).toContain('exit code of 0');
  expect(prompt).toContain('NOT evidence');
  expect(prompt).toContain('git diff --stat');
  expect(prompt).toMatch(/empty diff.*REFUTED/i);
  // Acceptance-criteria-against-working-tree instruction.
  expect(prompt).toMatch(/Acceptance criteria/i);
  expect(prompt).toMatch(/working tree/i);
});

test('(d) buildValidationPrompt degrades gracefully when the PRD path could not be resolved', () => {
  const prompt = buildValidationPrompt({ prdSlug: SLUG, prdPath: null, outcome: 'failed' });
  expect(prompt).toContain(SLUG);
  expect(prompt).toContain('path could not be resolved');
  expect(prompt).toContain('"failed"');
});

// ─── (e) LOOP GUARD ─────────────────────────────────────────────────────────

test('(e) LOOP GUARD: an appended event that is a validation result never enqueues a further prompt', () => {
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => indexAfterCheckin());

  for (const eventValidation of ['verified', 'refuted', 'validating', undefined]) {
    const res = maybeEnqueueValidationPrompt(callArgs({ eventValidation }), { sendPrompt, readActiveIndex });
    expect(res).toEqual({ enqueued: false, reason: 'not-a-checkin' });
  }
  expect(sendPrompt).not.toHaveBeenCalled();
});

// ─── kill-switch ────────────────────────────────────────────────────────────

test('SM_EPIC_VALIDATION_DISABLE=1 turns the hook off entirely', () => {
  process.env.SM_EPIC_VALIDATION_DISABLE = '1';
  const sendPrompt = vi.fn();
  const readActiveIndex = vi.fn(() => indexAfterCheckin());

  const res = maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex });

  expect(res).toEqual({ enqueued: false, reason: 'disabled' });
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(readActiveIndex).not.toHaveBeenCalled();
});

// ─── never throws ───────────────────────────────────────────────────────────

test('a sendPrompt that throws is swallowed and logged, never propagated (fire-and-forget contract)', () => {
  const sendPrompt = vi.fn(() => { throw new Error('IPC gone'); });
  const readActiveIndex = vi.fn(() => indexAfterCheckin());
  const log = { error: vi.fn() };

  let res;
  expect(() => {
    res = maybeEnqueueValidationPrompt(callArgs(), { sendPrompt, readActiveIndex, log });
  }).not.toThrow();
  expect(res).toEqual({ enqueued: false, reason: 'error' });
  expect(log.error).toHaveBeenCalled();
});

// ─── wiring through notifyOriginatingTab ────────────────────────────────────

test('notifyOriginatingTab: a routed check-in stamps validation:unvalidated and fires the validation hook once with the Epic id + slug', async () => {
  const sendPrompt = vi.fn();
  const appendResponseEvent = vi.fn(async () => true);
  const enqueueValidation = vi.fn(() => ({ enqueued: true }));
  const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: EPIC, path: PRD_PATH }));
  const loadSessions = vi.fn(async () => ({ tabs: [] }));

  await notifyOriginatingTab(
    { slug: SLUG, status: 'completed', cwd: '/some/cwd' },
    { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent, enqueueValidation },
  );

  expect(appendResponseEvent).toHaveBeenCalledWith(
    '/some/cwd', EPIC, expect.stringContaining(SLUG),
    expect.objectContaining({ prdSlug: SLUG, outcome: 'completed', validation: 'unvalidated' }),
  );
  expect(enqueueValidation).toHaveBeenCalledTimes(1);
  expect(enqueueValidation).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: '/some/cwd',
      epicId: EPIC,
      prdSlug: SLUG,
      outcome: 'completed',
      eventValidation: 'unvalidated',
    }),
    expect.objectContaining({ sendPrompt }),
  );
  // The check-in routed into the Epic chain — no tab-prompt fallback fires.
  expect(sendPrompt).not.toHaveBeenCalled();
});

test('notifyOriginatingTab: a REFUSED append (unknown/completed Epic) never fires the validation hook', async () => {
  const sendPrompt = vi.fn();
  const appendResponseEvent = vi.fn(async () => false);
  const enqueueValidation = vi.fn();
  const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: EPIC, sourceTabId: 'tab-x' }));
  const loadSessions = vi.fn(async () => ({ tabs: [] }));

  await notifyOriginatingTab(
    { slug: SLUG, status: 'completed', cwd: '/some/cwd' },
    { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent, enqueueValidation },
  );

  expect(enqueueValidation).not.toHaveBeenCalled();
});

test('notifyOriginatingTab: a validation hook that throws never blocks the notification path', async () => {
  const sendPrompt = vi.fn();
  const appendResponseEvent = vi.fn(async () => true);
  const enqueueValidation = vi.fn(() => { throw new Error('boom'); });
  const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: EPIC, path: PRD_PATH }));
  const loadSessions = vi.fn(async () => ({ tabs: [] }));

  await expect(
    notifyOriginatingTab(
      { slug: SLUG, status: 'failed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent, enqueueValidation },
    ),
  ).resolves.not.toThrow();
});
