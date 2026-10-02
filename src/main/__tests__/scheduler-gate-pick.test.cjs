/**
 * scheduler-gate-pick.test.cjs — fair gate-shadow pick + the live-row check
 * that keeps a probe from ever launching against a row the gate is already
 * handling or that already finished (review findings #3 and #8).
 *
 * Part 1: selectGateShadowTarget — pure, no I/O. Tier 1 (gate-authority-
 * eligible, stale) rotates oldest-first instead of always taking the first
 * queue-order row; tier 2 (plain observe-only) is the unchanged fallback.
 *
 * Part 2: spawnInvestigation's live-row re-check. HOME is overridden to a
 * tmp dir BEFORE requiring scheduler.cjs — same reason as
 * scheduler-gate-shadow.test.cjs and scheduler-investigation-spawn-lockdown.
 * test.cjs: activeSessions.cjs bakes os.homedir() into a top-level const at
 * require time, so HOME must already be the tmp dir by then or project
 * registration under it is invisible to the merged-queue read.
 *
 * Part 3 (deferred-drain skip) is NOT included: `deferredInvestigations`,
 * `drainDeferredInvestigation`, and `gateShadowSlug` are not exported from
 * scheduler.cjs, and this change adds no export beyond `selectGateShadowTarget`
 * — so there is no way to reach or observe the drain's skip-list from a test
 * file without adding one. Skipped per the brief's own fallback.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-gate-pick.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-pick-test-'));
process.env.HOME = tmpHome;

const { selectGateShadowTarget, spawnInvestigation } = require('../scheduler.cjs');
const { bustCwdCache } = require('../lib/queueStore.cjs');
const runtimeState = require('../lib/schedulerRuntimeState.cjs');
const { GATE_AUTHORITY_VERDICTS } = require('../lib/gateAuthority.cjs');

const VERDICT = GATE_AUTHORITY_VERDICTS[0]; // 'transcript_errors'

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

// ─── Part 1: selectGateShadowTarget ─────────────────────────────────────────

test('never-run beats a row that already ran, even recently', () => {
  const headByCwd = new Map([['p', 'head1']]);
  const neverRun = { slug: 'never-run', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c1' };
  const ranRecently = {
    slug: 'ran-recently', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c2',
    gateShadow: { head: 'stale-head', definitive: false, ranAt: new Date().toISOString() },
  };
  const picked = selectGateShadowTarget([ranRecently, neverRun], headByCwd, {});
  assert.equal(picked.slug, 'never-run');
});

test('among rows that already ran, the oldest gateShadow.ranAt wins', () => {
  const headByCwd = new Map([['p', 'head1']]);
  const rowOld = {
    slug: 'ran-old', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c1',
    gateShadow: { head: 'stale-head', definitive: false, ranAt: '2020-01-01T00:00:00.000Z' },
  };
  const rowNew = {
    slug: 'ran-new', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c2',
    gateShadow: { head: 'stale-head', definitive: false, ranAt: '2024-01-01T00:00:00.000Z' },
  };
  const picked = selectGateShadowTarget([rowNew, rowOld], headByCwd, {});
  assert.equal(picked.slug, 'ran-old');
});

test('a gateShadow marked definitive:true at the current HEAD is not stale — skipped entirely', () => {
  const headByCwd = new Map([['p', 'head1']]);
  const row = {
    slug: 'definitive-current', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c1',
    gateShadow: { head: 'head1', definitive: true, ranAt: new Date().toISOString() },
  };
  assert.equal(selectGateShadowTarget([row], headByCwd, {}), null);
});

test('a gateShadow at the current HEAD but not marked definitive is still stale — picked', () => {
  const headByCwd = new Map([['p', 'head1']]);
  const row = {
    slug: 'non-definitive-current', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c1',
    gateShadow: { head: 'head1', definitive: false, ranAt: new Date().toISOString() },
  };
  assert.equal(selectGateShadowTarget([row], headByCwd, {}).slug, 'non-definitive-current');
});

test('a row whose cwd has no known HEAD (null) is never picked', () => {
  const headByCwd = new Map([['p', null]]);
  const row = { slug: 'no-head', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c1' };
  assert.equal(selectGateShadowTarget([row], headByCwd, {}), null);
});

test('authorityDisabled drops tier 1, falling back to a plain tier-2 row', () => {
  const headByCwd = new Map([['p', 'head1']]);
  const authorityRow = {
    slug: 'authority-row', status: 'needs_review', cwd: 'p', verifierVerdict: VERDICT, landedCommit: 'c1',
    gateShadow: { head: 'stale-head', definitive: false, ranAt: new Date().toISOString() },
  };
  const observeRow = { slug: 'observe-row', status: 'needs_review', cwd: 'p' }; // no verdict, no gateShadow
  const jobs = [authorityRow, observeRow];
  assert.equal(selectGateShadowTarget(jobs, headByCwd, { authorityDisabled: false }).slug, 'authority-row');
  assert.equal(selectGateShadowTarget(jobs, headByCwd, { authorityDisabled: true }).slug, 'observe-row');
});

test('tier 2: a plain observe-only row that never got a shadow run is returned when no tier-1 row qualifies', () => {
  const headByCwd = new Map([['p', 'head1']]);
  const row = { slug: 'observe-only', status: 'needs_review', cwd: 'p' };
  assert.equal(selectGateShadowTarget([row], headByCwd, {}).slug, 'observe-only');
});

// ─── Part 2: spawnInvestigation's live-row re-check ────────────────────────

// Mirrors scheduler-investigation-spawn-lockdown.test.cjs's own setup (same
// file this live-row check was added for), reduced to what this one case
// needs: a real git repo as the job's cwd, registered as a live project so
// the merged queue read can find it, with a queue.json row already moved to
// 'completed' — simulating the background gate shadow completing the row in
// the same pass, before this (stale) deferred/auto-fix snapshot gets spawned.
test('spawnInvestigation skips the spawn when the live row has already moved on (e.g. completed by the gate)', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'gate-pick-cwd-'));
  git(['init', '-b', 'main'], cwd);
  git(['config', 'user.email', 't@example.com'], cwd);
  git(['config', 'user.name', 'T'], cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'x');
  git(['add', 'README.md'], cwd);
  git(['commit', '-m', 'init'], cwd);

  const slugDir = path.join(tmpHome, '.claude', 'projects', 'gate-pick-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 't.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();

  const slug = '99-gate-pick-completed-row';
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queuePath = path.join(stateDir, 'queue.json');
  // The live row: already 'completed', not the stale snapshot below.
  fs.writeFileSync(queuePath, JSON.stringify({ jobs: [{ slug, status: 'completed', cwd }] }, null, 2));

  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'gate-pick-run-'));
  const investigationLogPath = path.join(runDir, `${slug}.investigation.log`);
  const markerPath = path.join(cwd, 'investigation-argv.marker');

  const claudeStub = require('../../../tests/helpers/claudeStub.cjs');
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({
    body: `
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(process.cwd(), 'investigation-argv.marker'), 'spawned');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
      process.exit(0);
    `,
  });

  try {
    runtimeState.__resetForTests();
    // Stale snapshot: the caller's own copy still says 'failed' — only the
    // LIVE row (just written above) already shows 'completed'.
    const staleSnapshot = { slug, status: 'failed', cwd };
    const result = await spawnInvestigation(staleSnapshot, runDir);

    assert.deepEqual(result, { deferred: false });
    assert.equal(fs.existsSync(markerPath), false, 'no real child was ever spawned');
    assert.equal(runtimeState.investigationCount(), 0, 'the reserved slot was released back');

    const row = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
    assert.equal(row.status, 'completed', 'the live row was left exactly as it was');

    const log = fs.readFileSync(investigationLogPath, 'utf8');
    assert.match(log, /is now completed — not probing/);
  } finally {
    delete process.env.SM_CLAUDE_BIN;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true, force: true });
    bustCwdCache();
  }
});
