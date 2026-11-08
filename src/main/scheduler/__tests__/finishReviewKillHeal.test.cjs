/**
 * finishReviewKillHeal.test.cjs — a budget_exceeded park whose kill hit inside
 * the finish-protocol review (budgetKillPhase 'finish-review') after its commit
 * landed gets exactly one gate re-verification: green → completed with a reason
 * naming the skipped review; red / unrunnable / not integrated → stays
 * needs_review, never retried. Every other budget_exceeded row stays excluded.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs (top-level consts bake in
 * os.homedir() — see scheduler-gate-shadow.test.cjs, whose harness this mirrors).
 *
 * Run: timeout 300 npx vitest run src/main/scheduler/__tests__/finishReviewKillHeal.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-review-heal-test-'));
process.env.HOME = tmpHome;
process.env.SM_AUTOFIX_DISABLE = '1';
delete process.env.SM_FINISH_REVIEW_HEAL_DISABLE;

const reviewLadder = require('../reviewLadder.cjs');
const { runFinishReviewKillHeal, awaitGateShadowIdle, broadcast } = require('../../scheduler.cjs');
const { resolveEpicPrdWriteDir } = require('../../lib/prd/prdLocations.cjs');
const { bustCwdCache } = require('../../lib/scheduler/queueStore.cjs');

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

const baseRow = () => ({
  slug: '01-x',
  status: 'needs_review',
  cwd: '/tmp/x',
  verifierVerdict: 'budget_exceeded',
  budgetKillPhase: 'finish-review',
  landedCommit: 'abcdef1234567890',
});

describe('isFinishReviewKillHealEligible (pure)', () => {
  test('eligible row: finish-review kill with a landedCommit, never attempted', () => {
    assert.equal(reviewLadder.isFinishReviewKillHealEligible(baseRow()), true);
  });
  test('no landedCommit → not eligible', () => {
    assert.equal(reviewLadder.isFinishReviewKillHealEligible({ ...baseRow(), landedCommit: null }), false);
    assert.equal(reviewLadder.isFinishReviewKillHealEligible({ ...baseRow(), landedCommit: '' }), false);
  });
  test('budgetKillPhase absent → not eligible (other budget kills stay excluded)', () => {
    const { budgetKillPhase: _drop, ...row } = baseRow();
    assert.equal(reviewLadder.isFinishReviewKillHealEligible(row), false);
  });
  test('already attempted once → not eligible', () => {
    assert.equal(reviewLadder.isFinishReviewKillHealEligible({ ...baseRow(), finishReviewHealAttemptedAt: '2026-11-08T00:00:00.000Z' }), false);
  });
  test('integration failure stamped (commit stranded on sm-job branch) → not eligible', () => {
    assert.equal(reviewLadder.isFinishReviewKillHealEligible({ ...baseRow(), integrationFailureKind: 'content_conflict' }), false);
  });
  test('other verdicts / statuses → not eligible', () => {
    assert.equal(reviewLadder.isFinishReviewKillHealEligible({ ...baseRow(), verifierVerdict: 'transcript_errors' }), false);
    assert.equal(reviewLadder.isFinishReviewKillHealEligible({ ...baseRow(), status: 'completed' }), false);
  });
  test('RESCAN_EXCLUDED_VERDICTS and auto-fix exclusion unchanged for budget_exceeded', () => {
    assert.equal(reviewLadder.RESCAN_EXCLUDED_VERDICTS.has('budget_exceeded'), true);
    assert.equal(reviewLadder.isRescanCandidate(baseRow()), false);
    const targets = reviewLadder.selectAutoFixTargets([{ ...baseRow(), runId: 'r1' }], { fixSlugExists: () => false, resolveJobRunId: () => 'r1' });
    assert.deepEqual(targets, []);
  });
  test('selectGateShadowTarget picks the eligible row first, once only', () => {
    const head = new Map([['/tmp/x', 'h1']]);
    const other = { slug: '00-other', status: 'needs_review', cwd: '/tmp/x', verifierVerdict: 'transcript_errors' };
    assert.equal(reviewLadder.selectGateShadowTarget([other, baseRow()], head).slug, '01-x');
    const attempted = { ...baseRow(), finishReviewHealAttemptedAt: 'x', gateShadow: { head: 'h1', definitive: true } };
    assert.equal(reviewLadder.selectGateShadowTarget([attempted, other], head).slug, '00-other');
  });
});

// ── rung (real git + real gate runner) ─────────────────────────────────────

function setup(name, gateCmd, { integrate = true } = {}) {
  const cwd = path.join(tmpHome, name);
  fs.mkdirSync(cwd, { recursive: true });
  git(['init', '-q', '-b', 'main'], cwd);
  git(['config', 'user.email', 't@example.com'], cwd);
  git(['config', 'user.name', 'T'], cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'x\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'session-manager-operations/\n');
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', 'init'], cwd);
  // Backdated so the landed commit's committer date is after startedAt
  // (resolveLandedCommitEvidence's time bound; git truncates to seconds).
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  if (!integrate) git(['checkout', '-q', '-b', 'sm-job/side'], cwd);
  fs.writeFileSync(path.join(cwd, 'work.txt'), 'done\n');
  git(['add', 'work.txt'], cwd);
  git(['commit', '-q', '-m', 'feat: work'], cwd);
  const landedCommit = git(['rev-parse', 'HEAD'], cwd).trim();
  if (!integrate) git(['checkout', '-q', 'main'], cwd);

  const slugDir = path.join(tmpHome, '.claude', 'projects', `${name}-slug`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 't.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();
  const slug = `01-${name}`;
  const runId = `run-${name}`;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId), { recursive: true });
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queuePath = path.join(stateDir, 'queue.json');
  const parkReason = 'budget kill during finish-protocol review';
  const job = {
    slug, status: 'needs_review', cwd, runId, startedAt, finishedAt: new Date().toISOString(),
    verifierVerdict: 'budget_exceeded', budgetKillPhase: 'finish-review', landedCommit,
    statusHistory: [{ from: 'running', to: 'needs_review', at: new Date().toISOString(), reason: parkReason, source: 'test' }],
  };
  fs.writeFileSync(queuePath, JSON.stringify({ jobs: [job] }, null, 2));
  const prdDir = resolveEpicPrdWriteDir(cwd, 'heal-epic');
  fs.mkdirSync(prdDir, { recursive: true });
  fs.writeFileSync(path.join(prdDir, `${slug}.md`), `---\ntitle: T\ncwd: ${cwd}\nestimateMinutes: 5\ncreatedVia: scheduler-api\nissuedAt: 2026-11-08T00:00:00.000Z\n---\n# Acceptance criteria\n\n- [ ] Gate: \`${gateCmd}\`\n`);
  return { cwd, slug, job, queuePath, landedCommit, parkReason };
}

const readRow = (t) => JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);

afterEach(async () => {
  await awaitGateShadowIdle();
  await broadcast({ flush: true });
  fs.rmSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true, force: true });
  bustCwdCache();
});

describe('runFinishReviewKillHeal (rung)', () => {
  test('gate green on the landed tree → completed, reason names the skipped review', async () => {
    // The gate checks the landed file is present in the tree it runs against.
    const t = setup('green', 'timeout 30 node -e "process.exit(require(\'fs\').existsSync(\'work.txt\')?0:7)"');
    const rec = await runFinishReviewKillHeal(t.job);
    assert.equal(rec.gateStatus, 'green');
    assert.equal(rec.complete, true);
    const row = readRow(t);
    assert.equal(row.status, 'completed');
    assert.ok(row.finishReviewHealAttemptedAt);
    assert.equal(row.verifierVerdict, undefined);
    const last = row.statusHistory[row.statusHistory.length - 1];
    assert.equal(last.reason, `finish-protocol review killed at budget; gate re-run green on ${t.landedCommit.slice(0, 7)}; review skipped`);
    assert.equal(last.source, 'finishReviewKillHeal');
  });

  test('gate red → stays needs_review with its existing reason, and is never retried', async () => {
    const t = setup('red', 'timeout 30 node -e "process.exit(3)"');
    const rec = await runFinishReviewKillHeal(t.job);
    assert.equal(rec.gateStatus, 'red');
    assert.equal(rec.complete, false);
    const row = readRow(t);
    assert.equal(row.status, 'needs_review');
    assert.equal(row.verifierVerdict, 'budget_exceeded');
    assert.equal(row.statusHistory[row.statusHistory.length - 1].reason, t.parkReason);
    assert.ok(row.finishReviewHealAttemptedAt, 'attempt stamped');
    assert.equal(reviewLadder.isFinishReviewKillHealEligible(row), false, 'no loop');
    assert.equal(await runFinishReviewKillHeal(row), null, 'second call is a no-op');
  });

  test('landedCommit not integrated into main → not healed, gate never run', async () => {
    const t = setup('stranded', 'timeout 30 node -e "process.exit(0)"', { integrate: false });
    const rec = await runFinishReviewKillHeal(t.job);
    assert.equal(rec.complete, false);
    assert.equal(rec.reason, 'commit-not-integrated');
    assert.equal(rec.gateStatus, 'unavailable');
    const row = readRow(t);
    assert.equal(row.status, 'needs_review');
    assert.ok(row.finishReviewHealAttemptedAt);
  });

  test('budgetKillPhase absent → rung refuses without touching the row', async () => {
    const t = setup('nophase', 'timeout 30 node -e "process.exit(0)"');
    const { budgetKillPhase: _drop, ...job } = t.job;
    fs.writeFileSync(t.queuePath, JSON.stringify({ jobs: [job] }, null, 2));
    assert.equal(await runFinishReviewKillHeal(job), null);
    const row = readRow(t);
    assert.equal(row.status, 'needs_review');
    assert.equal(row.finishReviewHealAttemptedAt, undefined);
  });
});
