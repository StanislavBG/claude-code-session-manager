/**
 * scheduler-cancel-durable.test.cjs
 *
 * remote.cancelJob stamps a durable `cancelledAt`; no automated pass may
 * revive the row (incident 2026-10-19 git-viewer: cancelled 70/71 were
 * auto-reset after 10m and ran). Only an explicit human reset does.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs (paths are baked at require).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-cancel-durable.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-durable-test-'));
process.env.HOME = tmpHome;

const scheduler = require('../scheduler.cjs');
const reviewLadder = require('../scheduler/reviewLadder.cjs');
const { bustCwdCache } = require('../lib/scheduler/queueStore.cjs');

const SLUG = '9001-cancel-durable';

function seed() {
  const cwd = path.join(tmpHome, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  const prds = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prds, { recursive: true });
  fs.writeFileSync(path.join(prds, `${SLUG}.md`), 'Test fixture PRD.', 'utf8');
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queuePath = path.join(stateDir, 'queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ jobs: [{ slug: SLUG, status: 'pending', cwd }] }, null, 2));
  bustCwdCache();
  return { cwd, queuePath };
}

test('cancelled pending job survives every automated revive path; explicit reset revives it', async () => {
  const { cwd, queuePath } = seed();
  const res = await scheduler.remote.cancelJob(SLUG, { cwd });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'failed');
  assert.ok(res.cancelledAt);

  const job = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === SLUG);
  assert.equal(job.status, 'failed');
  assert.equal(job.cancelledAt, res.cancelledAt);
  const historyLen = job.statusHistory.length;

  const base = Date.now();
  for (let i = 1; i <= 4; i++) {
    const now = base + i * reviewLadder.FAILED_AUTORESET_MS * 3;
    assert.equal(reviewLadder.selectFailedAutoResetTargets([job], now, reviewLadder.FAILED_AUTORESET_MS).length, 0);
    for (const source of ['autoResetFailed', 'spawnJob:transient-retry', 'applyOrphanOutcome']) {
      assert.equal(scheduler.resetJobFields(job, 'x', { source }), false);
    }
  }
  assert.equal(scheduler.healTargetForFix(`${SLUG.split('-')[0]}-fix-cancel-durable`, [job]), null);
  assert.equal(job.status, 'failed');
  assert.equal(job.cancelledAt, res.cancelledAt);
  assert.equal(job.statusHistory.length, historyLen);
  assert.ok(!job.statusHistory.slice(historyLen).some((h) => h.to === 'pending' || h.to === 'running'));

  assert.equal(scheduler.resetJobFields(job, null, { source: 'remote:resetJob' }), true);
  assert.equal(job.status, 'pending');
  assert.equal(job.cancelledAt, undefined);
});
