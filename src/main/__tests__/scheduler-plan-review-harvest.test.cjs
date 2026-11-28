'use strict';

// Run: timeout 300 npx vitest run src/main/__tests__/scheduler-plan-review-harvest.test.cjs
import { beforeAll, beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearMainModuleCache } = require('./_helpers/schedulerHarness.cjs');

const EPIC = 'abc123';
let notifyOriginatingTab;
let readPlanReview;
let cwd;

const rows = () => [
  { slug: '10-a', cwd, status: 'completed' },
  { slug: '11-b', cwd, status: 'completed' },
  { slug: '12-validate', cwd, status: 'pending', agentType: 'validator', planReview: 'required', dependsOn: ['10-a', '11-b'] },
];
const reviewJob = (over = {}) => ({
  slug: '13-plan-review-validate', cwd, status: 'completed', agentType: 'plan-reviewer', runId: 'r1', epicId: EPIC, ...over,
});
const okReview = {
  prds: [{ prd: '10-a', decision: 'ok', findings: [] }, { prd: '11-b', decision: 'ok', findings: [] }],
  planFindings: [],
};
const amendReview = {
  prds: [
    { prd: '10-a', decision: 'ok', findings: [] },
    { prd: '11-b', decision: 'amend', findings: [{ severity: 'Important', check: 'edge-case', text: 'misses empty input', suggestedEdit: 'add an AC for empty input' }] },
  ],
  planFindings: [],
};

async function run(job, structured, sendPrompt) {
  await notifyOriginatingTab(job, {
    parsePrdRaw: async () => ({ sourcePromptId: EPIC }),
    loadSessions: async () => ({ tabs: [] }),
    sendPrompt,
    appendResponseEvent: async () => true,
    appendTranscriptTurn: async () => {},
    readResultFromLog: () => 'x',
    readStructuredFromLog: () => structured,
    scheduleSettle: () => {},
    planReviewRows: rows(),
  });
}
const digests = (send) => send.mock.calls.filter((c) => c[2] && c[2].heldKind === 'scheduler-notice');

describe('plan review harvest', () => {
  beforeAll(() => {
    clearMainModuleCache();
    ({ notifyOriginatingTab } = require('../scheduler.cjs'));
    ({ readPlanReview } = require('../lib/scheduler/planReviewStore.cjs'));
  });
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-harvest-'));
    fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  test('all-ok review auto-releases and says so', async () => {
    const send = vi.fn();
    await run(reviewJob(), okReview, send);
    const rec = readPlanReview(cwd, EPIC, '12-validate');
    expect(rec.release.by).toBe('auto');
    expect(rec.release.accepted).toBe(0);
    const [epic, text, opts] = digests(send)[0];
    expect(epic).toBe(EPIC);
    expect(text.split('\n')[0]).toBe('PLAN REVIEWED: 12-validate (round 1)');
    expect(text).toContain('released automatically');
    expect(opts.origin).toBe('scheduler');
  });

  test('amend review lists findings and the release call, no release', async () => {
    const send = vi.fn();
    await run(reviewJob(), amendReview, send);
    const rec = readPlanReview(cwd, EPIC, '12-validate');
    expect(rec.release).toBeNull();
    expect(rec.reviews).toHaveLength(1);
    const text = digests(send)[0][1];
    expect(text).toContain('11-b: amend');
    expect(text).toContain('[Important] edge-case: misses empty input');
    expect(text).toContain('add an AC for empty input');
    expect(text).toContain('scheduler_update_prd');
    expect(text).toContain('scheduler_release_plan');
  });

  test('malformed output releases as review-failed', async () => {
    const send = vi.fn();
    await run(reviewJob(), { nonsense: true }, send);
    const rec = readPlanReview(cwd, EPIC, '12-validate');
    expect(rec.release.by).toBe('timeout');
    expect(rec.release.rejected[0].reason).toBe('review-failed');
    expect(digests(send)[0][1]).toContain('review-failed');
  });

  test('missing output releases too', async () => {
    const send = vi.fn();
    await run(reviewJob(), null, send);
    expect(readPlanReview(cwd, EPIC, '12-validate').release.by).toBe('timeout');
    expect(digests(send)).toHaveLength(1);
  });

  test('the digest is sent once per round, across repeats', async () => {
    const send = vi.fn();
    await run(reviewJob(), amendReview, send);
    await run(reviewJob(), amendReview, send);
    expect(digests(send)).toHaveLength(1);
    expect(readPlanReview(cwd, EPIC, '12-validate').reviews).toHaveLength(1);
    expect(readPlanReview(cwd, EPIC, '12-validate').digestSent).toEqual([{ round: 1, kind: 'reviewed' }]);
  });

  test('needs_review reviewer is harvested as review-failed, one digest, deduped on repeat', async () => {
    const send = vi.fn();
    await run(reviewJob({ status: 'needs_review' }), null, send);
    const rec = readPlanReview(cwd, EPIC, '12-validate');
    expect(rec.release.by).toBe('timeout');
    expect(rec.release.rejected[0].reason).toBe('review-failed');
    expect(digests(send)).toHaveLength(1);
    expect(digests(send)[0][1]).toContain('review-failed');
    expect(digests(send)[0][1]).toContain('reviewer needs_review');
    await run(reviewJob({ status: 'needs_review' }), null, send);
    expect(digests(send)).toHaveLength(1);
  });

  test('needs_review reviewer output is not parsed (completed-only rule): still review-failed', async () => {
    const send = vi.fn();
    await run(reviewJob({ status: 'needs_review' }), amendReview, send);
    const rec = readPlanReview(cwd, EPIC, '12-validate');
    expect(rec.release.rejected[0].reason).toBe('review-failed');
    expect(digests(send)).toHaveLength(1);
    expect(digests(send)[0][1]).toContain('reviewer needs_review');
  });

  test('review-failed harvest then late valid harvest: review saved, one late digest, release unchanged', async () => {
    const send = vi.fn();
    await run(reviewJob({ status: 'needs_review' }), null, send);
    const before = readPlanReview(cwd, EPIC, '12-validate').release;
    await run(reviewJob(), amendReview, send);
    const rec = readPlanReview(cwd, EPIC, '12-validate');
    expect(rec.reviews).toHaveLength(1);
    expect(rec.release).toEqual(before);
    expect(digests(send)).toHaveLength(2);
    const text = digests(send)[1][1];
    expect(text.split('\n')[0]).toBe('PLAN REVIEWED (late): 12-validate (round 1)');
    expect(text).toContain('[Important] edge-case: misses empty input');
    expect(rec.digestSent).toEqual([{ round: 1, kind: 'late' }]);
    await run(reviewJob(), amendReview, send);
    expect(digests(send)).toHaveLength(2);
    expect(readPlanReview(cwd, EPIC, '12-validate').reviews).toHaveLength(1);
  });

  test('a valid harvest repeated is skipped', async () => {
    const send = vi.fn();
    await run(reviewJob(), okReview, send);
    await run(reviewJob(), okReview, send);
    expect(digests(send)).toHaveLength(1);
    expect(readPlanReview(cwd, EPIC, '12-validate').reviews).toHaveLength(1);
  });
});
