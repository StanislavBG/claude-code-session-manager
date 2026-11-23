/**
 * eventEmitters.test.cjs — the Epic event log's producers outside the scheduler loop:
 * epic.minted at mint (epicMint.cjs), job.needs_input / human.answer from the Needs-you
 * store (needsYouStore.cjs), and validator.verdict when a validator's verdicts file is
 * saved (planRecordHarvest.cjs saveValidatorVerdicts). Each runs against a temp ops root
 * and reads the real events.jsonl back through readEpicEvents.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/eventEmitters.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readEpicEvents, _resetForTests } = require('../epicEventLog.cjs');
const { ensureEpic, readActiveIndex, MINT_AUTHORITY_NEW_EPIC_UI } = require('../epicMint.cjs');
const { saveValidatorVerdicts } = require('../../scheduler/planRecordHarvest.cjs');

let cwd;
let schedHome;
let prevHome;

beforeEach(() => {
  _resetForTests();
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-emitters-')));
  schedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-emitters-home-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = schedHome;
  require('../../../config.cjs').addAllowedRoot(cwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(schedHome, { recursive: true, force: true });
});

const events = async (epicId) => (await readEpicEvents(cwd, epicId)).events;

// ── epic.minted ──────────────────────────────────────────────────────────

test('a mint appends epic.minted { agentType, tag, agentSnapshotId }', async () => {
  const persona = `emit-test-${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${persona}.md`), `---\nname: ${persona}\ndescription: emitter test\nmodel: opus\n---\nBODY\n`);

  const { epicId, created } = await ensureEpic(cwd, {
    mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, goalText: 'emit test', tag: 'feature', agentType: persona,
  });
  expect(created).toBe(true);
  const snapId = readActiveIndex(cwd).sessions[epicId].agentSnapshotId;
  expect(snapId).toMatch(/^[0-9a-f]{64}$/);

  const evs = await events(epicId);
  expect(evs).toHaveLength(1);
  expect(evs[0]).toMatchObject({ seq: 1, epicId, kind: 'epic.minted', agentType: persona, tag: 'feature', agentSnapshotId: snapId });
});

test('a join (created:false) appends nothing', async () => {
  const { epicId } = await ensureEpic(cwd, { mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, goalText: 'first' });
  expect(await events(epicId)).toHaveLength(1);
  const joined = await ensureEpic(cwd, { epicId, goalText: 'join' });
  expect(joined.created).toBe(false);
  expect(await events(epicId)).toHaveLength(1);
});

test('an event-log append failure is logged, never thrown into the mint', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await ensureEpic(
    cwd,
    { mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, goalText: 'append fails' },
    { appendEpicEvent: async () => { throw new Error('disk full'); } },
  );
  expect(r.created).toBe(true);
  expect(readActiveIndex(cwd).sessions[r.epicId]).toBeTruthy();
  expect(err.mock.calls.some((c) => String(c[0]).includes('epic.minted event append failed'))).toBe(true);
});

// ── job.needs_input / human.answer ─────────────────────────────────────────────

test('a Needs-you item with an epicId appends job.needs_input on post and human.answer on answer', async () => {
  const store = require('../../feedback-remote/needsYouStore.cjs');
  const epicId = 'epic-needs-1';
  const { item, created } = await store.postNeedsYou({
    app: 'portfolio', id: 'q-1', title: 'Pick one', options: ['A', 'B'], epicId, cwd,
  });
  expect(created).toBe(true);
  expect(item).toMatchObject({ epicId, cwd });

  // A re-post of the same open item is not a new question.
  await store.postNeedsYou({ app: 'portfolio', id: 'q-1', title: 'Pick one again', options: ['A', 'B'], epicId, cwd });
  let evs = await events(epicId);
  expect(evs.map((e) => e.kind)).toEqual(['job.needs_input']);
  expect(evs[0]).toMatchObject({ app: 'portfolio', id: 'q-1', title: 'Pick one', options: ['A', 'B'] });

  const answered = await store.answerNeedsYou({ app: 'portfolio', id: 'q-1', answer: 'B' });
  expect(answered.status).toBe('answered');
  evs = await events(epicId);
  expect(evs.map((e) => e.kind)).toEqual(['job.needs_input', 'human.answer']);
  expect(evs[1]).toMatchObject({ seq: 2, app: 'portfolio', id: 'q-1', answer: 'B' });

  // A refused answer (already answered) appends nothing.
  expect(await store.answerNeedsYou({ app: 'portfolio', id: 'q-1', answer: 'A' })).toBeNull();
  expect(await events(epicId)).toHaveLength(2);
});

test('a Needs-you item without an epicId keeps its shape and writes no event log', async () => {
  const store = require('../../feedback-remote/needsYouStore.cjs');
  const { item } = await store.postNeedsYou({ app: 'portfolio', id: 'q-2', title: 'Plain', options: ['A', 'B'] });
  expect('epicId' in item).toBe(false);
  expect('cwd' in item).toBe(false);
  await store.answerNeedsYou({ app: 'portfolio', id: 'q-2', answer: 'A' });
  expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'events'))).toBe(false);
});

test('a Needs-you post refuses an unsafe epicId or a relative cwd', async () => {
  const store = require('../../feedback-remote/needsYouStore.cjs');
  await expect(store.postNeedsYou({ app: 'portfolio', id: 'q-3', title: 'x', epicId: '../x', cwd })).rejects.toThrow();
  await expect(store.postNeedsYou({ app: 'portfolio', id: 'q-3', title: 'x', epicId: 'e1', cwd: 'rel/dir' })).rejects.toThrow();
});

// ── validator.verdict ─────────────────────────────────────────────────────────

test('saving <validate-slug>.verdicts.json appends validator.verdict { validateSlug, verdicts: [{ prd, verdict }] }', async () => {
  const epicId = 'epic-verdict-1';
  const record = {
    validator: '3790-validate-plan',
    runId: 'r1',
    at: new Date().toISOString(),
    schedulerVerdict: 'PASS',
    verdicts: [
      { prd: '3781-a', verdict: 'VERIFIED', reason: 'ok', missKinds: [] },
      { prd: '3782-b', verdict: 'REFUTED', reason: 'AC 2 missing', missKinds: ['ac'] },
    ],
  };
  const file = await saveValidatorVerdicts({ cwd, epicId, validateSlug: 'validate-plan', record });
  expect(file).toBe(path.join(cwd, 'session-manager-operations', 'plan-records', epicId, 'validate-plan.verdicts.json'));
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(record);

  const evs = await events(epicId);
  expect(evs).toHaveLength(1);
  expect(evs[0]).toMatchObject({ kind: 'validator.verdict', validateSlug: 'validate-plan' });
  expect(evs[0].verdicts).toEqual([
    { prd: '3781-a', verdict: 'VERIFIED' },
    { prd: '3782-b', verdict: 'REFUTED' },
  ]);
});

test('a verdict event-log failure is logged and the file still lands; a write failure appends nothing', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const epicId = 'epic-verdict-2';
  const record = { schedulerVerdict: 'PASS', verdicts: [{ prd: 'p', verdict: 'VERIFIED' }] };
  const file = await saveValidatorVerdicts({
    cwd, epicId, validateSlug: 'v', record, appendEvent: async () => { throw new Error('boom'); },
  });
  expect(fs.existsSync(file)).toBe(true);
  expect(err.mock.calls.some((c) => String(c[0]).includes('validator.verdict event append failed'))).toBe(true);

  await expect(saveValidatorVerdicts({
    cwd, epicId: 'epic-verdict-3', validateSlug: 'v', record, write: async () => { throw new Error('disk full'); },
  })).rejects.toThrow('disk full');
  expect(await events('epic-verdict-3')).toHaveLength(0);
});
