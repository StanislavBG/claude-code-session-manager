'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/planReviewStore.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  planReviewPath, readPlanReview, savePlanReviewResult, recordPlanRelease, readPlanReviewFiles, markCreateRefused,
} = require('../planReviewStore.cjs');

let cwd;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-'));
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
});
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

const base = { epicId: 'abc123', validateSlug: 'validate-x' };
const save = (round) => savePlanReviewResult({
  cwd, ...base, round, reviewer: 'r', runId: 'run1', model: 'm', review: { findings: [] },
});

describe('planReviewStore', () => {
  it('round-trips a saved review', async () => {
    assert.equal(readPlanReview(cwd, base.epicId, base.validateSlug), null);
    await save(1);
    await save(2);
    const rec = readPlanReview(cwd, base.epicId, base.validateSlug);
    assert.equal(rec.round, 2);
    assert.equal(rec.reviews.length, 2);
    assert.equal(rec.release, null);
    assert.equal(rec.reviews[0].runId, 'run1');
    assert.ok(planReviewPath(cwd, base.epicId, base.validateSlug).endsWith('validate-x.plan-review.json'));
    assert.equal(readPlanReviewFiles(cwd, base.epicId).length, 1);
  });

  it('release is idempotent and keeps reviews', async () => {
    await save(1);
    const first = await recordPlanRelease({
      cwd, ...base, by: 'planner', rejected: [{ finding: 'f', reason: 'why' }], accepted: 2,
    });
    assert.equal(first.release.by, 'planner');
    assert.equal(first.release.accepted, 2);
    const again = await recordPlanRelease({ cwd, ...base, by: 'auto', accepted: 9 });
    assert.deepEqual(again, { alreadyReleased: true });
    const rec = readPlanReview(cwd, base.epicId, base.validateSlug);
    assert.equal(rec.release.by, 'planner');
    assert.equal(rec.reviews.length, 1);
  });

  it('keeps digestSent and rereviewRequested across save and release; round 2 clears rereviewRequested', async () => {
    await save(1);
    const file = planReviewPath(cwd, base.epicId, base.validateSlug);
    const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
    seeded.digestSent = true;
    seeded.rereviewRequested = true;
    fs.writeFileSync(file, JSON.stringify(seeded));
    await save(1);
    let rec = readPlanReview(cwd, base.epicId, base.validateSlug);
    assert.equal(rec.digestSent, true);
    assert.equal(rec.rereviewRequested, true);
    await recordPlanRelease({ cwd, ...base, by: 'auto' });
    rec = readPlanReview(cwd, base.epicId, base.validateSlug);
    assert.equal(rec.digestSent, true);
    assert.equal(rec.rereviewRequested, true);
    assert.deepEqual(await recordPlanRelease({ cwd, ...base, by: 'auto' }), { alreadyReleased: true });
    await save(2);
    rec = readPlanReview(cwd, base.epicId, base.validateSlug);
    assert.equal(rec.rereviewRequested, false);
    assert.equal(rec.digestSent, true);
  });

  it('refuses unsafe ids without writing', async () => {
    for (const [e, s] of [['../x', 'v'], ['abc', '../v'], ['a/b', 'v'], ['abc', 'a/b'], ['abc', '..']]) {
      assert.throws(() => planReviewPath(cwd, e, s));
      assert.equal(readPlanReview(cwd, e, s), null);
      await assert.rejects(savePlanReviewResult({ cwd, epicId: e, validateSlug: s, round: 1 }));
      await assert.rejects(recordPlanRelease({ cwd, epicId: e, validateSlug: s, by: 'auto' }));
    }
    assert.deepEqual(readPlanReviewFiles(cwd, '../x'), []);
    assert.equal(fs.existsSync(path.join(cwd, 'session-manager-operations', 'plan-records')), false);
  });

  it('reads a malformed file as null and skips it in the listing', async () => {
    await save(1);
    const file = planReviewPath(cwd, base.epicId, base.validateSlug);
    fs.writeFileSync(file, '{not json');
    assert.equal(readPlanReview(cwd, base.epicId, base.validateSlug), null);
    assert.deepEqual(readPlanReviewFiles(cwd, base.epicId), []);
  });

  it('markCreateRefused is once per round and preserves the record', async () => {
    await save(1);
    assert.equal(await markCreateRefused(cwd, base.epicId, base.validateSlug, 1), true);
    assert.equal(await markCreateRefused(cwd, base.epicId, base.validateSlug, 1), false);
    assert.equal(await markCreateRefused(cwd, base.epicId, base.validateSlug, 2), true);
    const rec = readPlanReview(cwd, base.epicId, base.validateSlug);
    assert.deepEqual(rec.createRefusedLogged, [1, 2]);
    assert.equal(rec.reviews.length, 1);
    await save(2);
    assert.deepEqual(readPlanReview(cwd, base.epicId, base.validateSlug).createRefusedLogged, [1, 2]);
  });

  it('markCreateRefused creates a record when none exists', async () => {
    assert.equal(await markCreateRefused(cwd, base.epicId, base.validateSlug, 1), true);
    const rec = readPlanReview(cwd, base.epicId, base.validateSlug);
    assert.equal(rec.release, null);
    assert.deepEqual(rec.reviews, []);
  });
});
