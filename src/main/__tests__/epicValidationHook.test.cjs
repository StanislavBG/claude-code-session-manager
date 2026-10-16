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
  __resetSettleForTests,
  buildSettledDigest,
  runEpicSettle,
  scheduleEpicSettle,
} = require('../lib/epic/epicValidationHook.cjs');
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


// ─── settle runner ──────────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-15T12:00:00Z');
const at = (min) => new Date(NOW - (60 - min) * 60000).toISOString();

function checkin(slug, min, extra = {}) {
  return {
    id: `c-${slug}`, kind: 'response', at: at(min), text: `PRD ${slug} finished: completed.`,
    prdSlug: slug, outcome: 'completed', validation: 'unvalidated', agentType: 'dev-lead', ...extra,
  };
}
function verdict(slug, v, min, text = '') {
  return { id: `v-${slug}`, kind: 'response', at: at(min), text, prdSlug: slug, validation: v };
}
function settleIndex(events, status = 'active') {
  return { sessions: { [EPIC]: { id: EPIC, status } }, events: { [EPIC]: events } };
}
function settleDeps(events, over = {}) {
  return {
    readActiveIndex: vi.fn(() => settleIndex(events)),
    loadJobs: vi.fn(async () => []),
    loadHistory: vi.fn(async () => []),
    createPrd: vi.fn(async () => ({ ok: true })),
    resolveBaseSha: vi.fn(async () => 'base123'),
    sendPrompt: vi.fn(),
    appendResponseEvent: vi.fn(async () => true),
    now: () => NOW,
    log: { error: vi.fn() },
    ...over,
  };
}

beforeEach(() => { __resetSettleForTests(); });
afterEach(() => { vi.useRealTimers(); delete process.env.SM_EPIC_SETTLE_SECONDS; });

test('buildSettledDigest: sections with counts, empty ones omitted, record folder, no re-verify', () => {
  const text = buildSettledDigest(
    { verified: ['a', 'b'], refuted: [{ slug: 'c', reason: 'no test' }], failed: ['d'], parked: ['e'], uncovered: [{ slug: 'f', bareSlug: 'f' }] },
    { epicId: EPIC, notValidatedReason: 'because' },
  );
  expect(text.startsWith('PLAN SETTLED')).toBe(true);
  expect(text).toContain('Verified (2)');
  expect(text).toContain('REFUTED (1)');
  expect(text).toContain('- c — no test');
  expect(text).toContain('Failed (1)');
  expect(text).toContain('Parked (needs_review) (1)');
  expect(text).toContain('Not validated (1) — because');
  expect(text).toContain(`session-manager-operations/reviews/validation/${EPIC}/`);
  expect(text).toMatch(/not re-verify VERIFIED/i);
  const sparse = buildSettledDigest({ verified: ['a'] }, { epicId: EPIC });
  expect(sparse).not.toContain('REFUTED');
  expect(sparse).not.toContain('Failed');
  expect(sparse).not.toContain('Parked');
  expect(sparse).not.toContain('Not validated');
});

test('runEpicSettle: 15 verified check-ins produce one digest and zero sweeps', async () => {
  const events = [];
  for (let i = 0; i < 15; i++) {
    const slug = `${100 + i}-prd-${i}`;
    events.push(checkin(slug, i), verdict(slug, 'verified', i + 1));
  }
  const deps = settleDeps(events);
  const res = await runEpicSettle({ cwd: '/c', epicId: EPIC }, deps);
  expect(res.action).toBe('digest-sent');
  expect(deps.createPrd).not.toHaveBeenCalled();
  expect(deps.sendPrompt).toHaveBeenCalledTimes(1);
  expect(deps.sendPrompt.mock.calls[0][1]).toContain('Verified (15)');
  expect(deps.appendResponseEvent).toHaveBeenCalledWith(
    '/c', EPIC, 'Plan digest sent: 15 verified, 0 refuted, 0 not validated',
    expect.objectContaining({ outcome: 'digest', digestKey: expect.any(String) }),
  );
});

test('runEpicSettle: an unchecked PRD produces one createPrd call and zero prompts', async () => {
  const deps = settleDeps([checkin('200-unchecked', 1)], {
    loadHistory: vi.fn(async () => [{ slug: '200-unchecked', cwd: '/c', epicId: EPIC, landedCommit: 'abc', finishedAt: at(1) }]),
  });
  const res = await runEpicSettle({ cwd: '/c', epicId: EPIC }, deps);
  expect(res).toEqual({ action: 'sweep-queued', slug: expect.stringMatching(/^validate-sweep-/) });
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
  const input = deps.createPrd.mock.calls[0][0];
  expect(input.agentType).toBe('validator');
  expect(input.dependsOn).toEqual(['unchecked']);
  expect(input.implementationNotes).toContain('Base: base123');
  expect(deps.resolveBaseSha).toHaveBeenCalledWith('/c', 'abc');
  expect(deps.sendPrompt).not.toHaveBeenCalled();
  expect(deps.appendResponseEvent).not.toHaveBeenCalled();
});

test('runEpicSettle: second run with an unchanged digestKey sends nothing', async () => {
  const events = [checkin('300-a', 1), verdict('300-a', 'verified', 2)];
  const first = settleDeps(events);
  await runEpicSettle({ cwd: '/c', epicId: EPIC }, first);
  const meta = first.appendResponseEvent.mock.calls[0][3];
  const second = settleDeps([...events, { id: 'd', kind: 'response', at: at(0), text: 'x', ...meta }]);
  const res = await runEpicSettle({ cwd: '/c', epicId: EPIC }, second);
  expect(res).toEqual({ action: 'none', reason: 'already-digested' });
  expect(second.sendPrompt).not.toHaveBeenCalled();
  expect(second.createPrd).not.toHaveBeenCalled();
});

test('runEpicSettle: gates — kill-switch, inactive Epic, unsettled, no content', async () => {
  const events = [checkin('400-a', 1), verdict('400-a', 'verified', 2)];
  process.env.SM_EPIC_VALIDATION_DISABLE = '1';
  const d1 = settleDeps(events);
  expect((await runEpicSettle({ cwd: '/c', epicId: EPIC }, d1)).action).toBe('none');
  expect(d1.readActiveIndex).not.toHaveBeenCalled();
  delete process.env.SM_EPIC_VALIDATION_DISABLE;

  const d2 = settleDeps(events, { readActiveIndex: vi.fn(() => settleIndex(events, 'completed')) });
  expect((await runEpicSettle({ cwd: '/c', epicId: EPIC }, d2)).reason).toBe('epic-not-active');

  const d3 = settleDeps(events, { loadJobs: vi.fn(async () => [{ slug: '401-x', epicId: EPIC, cwd: '/c', status: 'running' }]) });
  expect((await runEpicSettle({ cwd: '/c', epicId: EPIC }, d3)).reason).toBe('not-settled');

  const d4 = settleDeps([]);
  expect((await runEpicSettle({ cwd: '/c', epicId: EPIC }, d4)).reason).toBe('no-content');
  for (const d of [d1, d2, d3, d4]) {
    expect(d.sendPrompt).not.toHaveBeenCalled();
    expect(d.createPrd).not.toHaveBeenCalled();
  }
});

test('runEpicSettle: createPrd ok:false or throwing falls back to ONE digest with the slugs under Not validated', async () => {
  for (const createPrd of [vi.fn(async () => ({ ok: false, error: 'nope' })), vi.fn(async () => { throw new Error('boom'); })]) {
    const deps = settleDeps([checkin('500-a', 1)], { createPrd });
    const res = await runEpicSettle({ cwd: '/c', epicId: EPIC }, deps);
    expect(res.action).toBe('digest-sent');
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1);
    const text = deps.sendPrompt.mock.calls[0][1];
    expect(text).toContain('Not validated (1)');
    expect(text).toContain('500-a');
    expect(text).toContain('the validator persona could not be queued');
    expect(deps.appendResponseEvent).toHaveBeenCalledWith(
      '/c', EPIC, expect.stringContaining('1 not validated'), expect.objectContaining({ outcome: 'digest' }),
    );
  }
});

test('runEpicSettle: slugs already in a sweep validator dependsOn are dropped; all swept → digest, partial → sweep of the rest', async () => {
  const sweepRow = { slug: '600-validate-sweep-202610150000', epicId: EPIC, cwd: '/c', status: 'completed', dependsOn: ['600-a'] };
  const all = settleDeps([checkin('600-a', 1)], { loadHistory: vi.fn(async () => [sweepRow]) });
  const r1 = await runEpicSettle({ cwd: '/c', epicId: EPIC }, all);
  expect(r1.action).toBe('digest-sent');
  expect(all.createPrd).not.toHaveBeenCalled();
  expect(all.sendPrompt.mock.calls[0][1]).toContain('a sweep validator already ran');

  const part = settleDeps([checkin('600-a', 1), checkin('601-b', 2)], { loadJobs: vi.fn(async () => [sweepRow]) });
  const r2 = await runEpicSettle({ cwd: '/c', epicId: EPIC }, part);
  expect(r2.action).toBe('sweep-queued');
  expect(part.createPrd.mock.calls[0][0].dependsOn).toEqual(['b']);
  expect(part.sendPrompt).not.toHaveBeenCalled();
});

test('scheduleEpicSettle: debounces, resets on a new call, timers unref, no double start', async () => {
  vi.useFakeTimers();
  let release;
  const run = vi.fn(() => new Promise((r) => { release = r; }));
  scheduleEpicSettle({ cwd: '/c', epicId: EPIC }, run, { delayMs: 1000 });
  await vi.advanceTimersByTimeAsync(600);
  scheduleEpicSettle({ cwd: '/c', epicId: EPIC }, run, { delayMs: 1000 });
  await vi.advanceTimersByTimeAsync(600);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith({ cwd: '/c', epicId: EPIC });

  // run still in flight: a new schedule fires but must not start a second run
  scheduleEpicSettle({ cwd: '/c', epicId: EPIC }, run, { delayMs: 10 });
  await vi.advanceTimersByTimeAsync(50);
  expect(run).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(0);

  // separate keys do not share a timer
  const other = vi.fn(async () => {});
  scheduleEpicSettle({ cwd: '/c', epicId: 'epic-other' }, other, { delayMs: 5 });
  await vi.advanceTimersByTimeAsync(10);
  expect(other).toHaveBeenCalledTimes(1);
});

test('scheduleEpicSettle: default delay is SM_EPIC_SETTLE_SECONDS or 120s; timer is unref\'d', async () => {
  vi.useFakeTimers();
  const run = vi.fn(async () => {});
  scheduleEpicSettle({ cwd: '/d', epicId: EPIC }, run);
  await vi.advanceTimersByTimeAsync(119000);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(run).toHaveBeenCalledTimes(1);

  process.env.SM_EPIC_SETTLE_SECONDS = '5';
  const run2 = vi.fn(async () => {});
  scheduleEpicSettle({ cwd: '/d', epicId: 'e2' }, run2);
  await vi.advanceTimersByTimeAsync(5100);
  expect(run2).toHaveBeenCalledTimes(1);

  process.env.SM_EPIC_SETTLE_SECONDS = 'abc';
  const run3 = vi.fn(async () => {});
  scheduleEpicSettle({ cwd: '/d', epicId: 'e3' }, run3);
  await vi.advanceTimersByTimeAsync(5100);
  expect(run3).not.toHaveBeenCalled();

  const spy = vi.spyOn(globalThis, 'setTimeout');
  scheduleEpicSettle({ cwd: '/d', epicId: 'e4' }, run3, { delayMs: 1 });
  const t = spy.mock.results[0].value;
  expect(typeof t === 'object' ? typeof t.unref : 'function').toBe('function');
  spy.mockRestore();
});
