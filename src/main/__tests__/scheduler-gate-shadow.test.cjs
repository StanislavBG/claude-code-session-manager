/**
 * scheduler-gate-shadow.test.cjs — the shadow gate records `gateShadow` on the
 * verdicts sidecar and the row. For most verdicts that is observation only:
 * status never changes. For the three gate-authority verdicts, with a landed
 * commit proven to be evidence from THIS dispatch (not a stale sha) and the
 * exact tree the gate ran against (HEAD unmoved, tree clean, both before and
 * after), a green re-run DOES complete the row — see the "gate authority"
 * tests below.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs (top-level consts bake in
 * os.homedir() — see scheduler-looks-done.test.cjs).
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-gate-shadow.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-shadow-test-'));
process.env.HOME = tmpHome;
// The trigger-re-pick test below is this file's first call to
// reverifyNeedsReview() — that function's OWN rung-4 (selectAutoFixTargets)
// also matches a fresh needs_review row with a runId and fires a REAL,
// fire-and-forget spawnInvestigation (same hazard scheduler-looks-done.test.cjs
// documents and disables for). Keep this file scoped to the gate-authority
// rung alone.
process.env.SM_AUTOFIX_DISABLE = '1';

const { runGateShadow, reverifyNeedsReview, awaitGateShadowIdle } = require('../scheduler.cjs');
const { runGateSequence } = require('../lib/definitionOfDone.cjs');
const { resolveEpicPrdWriteDir } = require('../lib/prdLocations.cjs');
const { bustCwdCache } = require('../lib/queueStore.cjs');
const { auditLogPath } = require('../lib/auditLog.cjs');

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

// A standalone script, never inside any test repo (so it never pollutes a
// test's own git status), that a gate command can invoke to dirty a tracked
// file mid-gate. Single-quoted in the gate strings below so neither this path
// nor the target path needs to be free of shell-ish characters for
// tokenizeNoShell to parse — see definitionOfDone.cjs.
const dirtyFileScript = path.join(tmpHome, 'dirty-file.cjs');
fs.writeFileSync(dirtyFileScript, 'require("fs").writeFileSync(process.argv[2], "dirtied\\n");\n');

function setup(name, gateBody) {
  const cwd = path.join(tmpHome, name);
  fs.mkdirSync(cwd, { recursive: true });
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 't@example.com'], cwd);
  git(['config', 'user.name', 'T'], cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'x\n');
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', 'init'], cwd);
  const slugDir = path.join(tmpHome, '.claude', 'projects', `${name}-slug`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 't.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();
  const prdDir = resolveEpicPrdWriteDir(cwd, 'gate-epic');
  fs.mkdirSync(prdDir, { recursive: true });
  const slug = `01-${name}`;
  fs.writeFileSync(path.join(prdDir, `${slug}.md`), `---\ntitle: T\ncwd: ${cwd}\nestimateMinutes: 5\n---\n${gateBody}\n`);
  const runId = `run-${name}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const verdictsPath = path.join(runDir, `${slug}.verdicts.json`);
  fs.writeFileSync(verdictsPath, JSON.stringify({ verdict: 'transcript_errors', reason: 'r' }));
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queuePath = path.join(stateDir, 'queue.json');
  // Backdated 60s: resolveLandedCommitEvidence (via evidenceOk) requires the
  // landed commit's committer date to be AT OR AFTER startedAt. The init
  // commit above and this timestamp are otherwise within the same second, and
  // git truncates committer dates to whole seconds, so an un-backdated
  // startedAt is flaky — it can land AFTER the commit it is meant to predate.
  const job = { slug, status: 'needs_review', cwd, runId, verifierVerdict: 'transcript_errors', startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString() };
  fs.writeFileSync(queuePath, JSON.stringify({ jobs: [job] }, null, 2));
  return { cwd, slug, job, verdictsPath, queuePath };
}

const ac = (cmd) => `# Acceptance criteria\n\n- [ ] Gate: \`${cmd}\`\n`;
const headSha = (cwd) => git(['rev-parse', 'HEAD'], cwd).trim();
function persistJob(t) {
  fs.writeFileSync(t.queuePath, JSON.stringify({ jobs: [t.job] }, null, 2));
}

// reverifyNeedsReview() scans EVERY project registered under
// tmpHome/.claude/projects, not just the one a given test just set up (same
// cross-test amplification scheduler-looks-done.test.cjs documents and works
// around). Only the trigger-re-pick test below calls reverifyNeedsReview();
// the rest call runGateShadow directly and never consult the registry, so
// this is a no-op for them.
afterEach(() => {
  fs.rmSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true, force: true });
  bustCwdCache();
});

test('green gate: recorded on sidecar + row, status untouched, verdict keys preserved', async () => {
  const t = setup('green', ac('timeout 30 node -e "process.exit(0)" && timeout 30 node -e "process.exit(0)"'));
  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.equal(rec.results.length, 2);
  const sidecar = JSON.parse(fs.readFileSync(t.verdictsPath, 'utf8'));
  assert.equal(sidecar.verdict, 'transcript_errors', 'read-merge keeps runVerify keys');
  assert.equal(sidecar.gateShadow.status, 'green');
  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review', 'shadow never transitions');
  assert.equal(row.gateShadow.status, 'green');
});

test('red gate stops at the first failure and records red; status still untouched', async () => {
  const t = setup('red', ac('timeout 30 node -e "process.exit(3)" && timeout 30 node -e "process.exit(0)"'));
  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'red');
  assert.equal(rec.results.length, 1);
  assert.equal(rec.results[0].code, 3);
  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

test('the gate runs with CI=1 and an isolated TMPDIR', async () => {
  const t = setup('env', ac('timeout 30 node -e "process.exit(process.env.CI===\'1\'&&process.env.TMPDIR.includes(\'sm-gate-shadow-\')?0:9)"'));
  assert.equal((await runGateShadow(t.job)).status, 'green');
});

test('gate: none is recorded as an explicit opt-out (unavailable), nothing spawned', async () => {
  const t = setup('optout', '# Acceptance criteria\n\n- [ ] `timeout 30 node -e "process.exit(9)"`\n');
  t.job.slug = t.slug;
  fs.writeFileSync(path.join(resolveEpicPrdWriteDir(t.cwd, 'gate-epic'), `${t.slug}.md`), `---\ntitle: T\ncwd: ${t.cwd}\ngate: none\n---\nbody\n`);
  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'unavailable');
  assert.equal(rec.reason, 'gate-opt-out');
  assert.deepEqual(rec.results, []);
});

test('no parseable gate → unavailable', async () => {
  const t = setup('nogate', '# Acceptance criteria\n\n- [ ] just prose\n');
  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'unavailable');
  assert.equal(rec.reason, 'no-parseable-gate');
});

test('at most one shadow gate in flight: a concurrent run reports busy and runs nothing', async () => {
  const slow = [{ argv: ['node', '-e', 'setTimeout(()=>{},400)'], timeoutMs: 10_000, env: {} }];
  const first = runGateSequence(slow, { cwd: tmpHome });
  const second = await runGateSequence(slow, { cwd: tmpHome });
  assert.equal(second.status, 'busy');
  assert.deepEqual(second.results, []);
  assert.equal((await first).status, 'green');
});

test('a hung command is killed at its timeout and the gate is red', async () => {
  const hang = [{ argv: ['node', '-e', 'setTimeout(()=>{},60000)'], timeoutMs: 300, env: {} }];
  const r = await runGateSequence(hang, { cwd: tmpHome });
  assert.equal(r.status, 'red');
  assert.equal(r.results[0].timedOut, true);
});

// ─── Gate authority: a green re-run completes a transcript-noise park ──────

test('gate authority: green re-run completes the row, archives the PRD, audits it', async () => {
  const t = setup('authGreen', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  const prdDir = resolveEpicPrdWriteDir(t.cwd, 'gate-epic');
  const prdPath = path.join(prdDir, `${t.slug}.md`);
  assert.ok(fs.existsSync(prdPath), 'PRD starts in the live prds/ dir');

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: true, reason: 'gate-green' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'completed');
  assert.equal(row.error, null);
  assert.equal('verifierVerdict' in row, false, 'verifierVerdict cleared');
  assert.equal(row.gateShadow.authority.complete, true);

  assert.equal(fs.existsSync(prdPath), false, 'archived out of the live prds/ dir');
  const archivedPath = path.join(prdDir, '..', 'prds-archived', `${t.slug}.md`);
  assert.ok(fs.existsSync(archivedPath), 'moved into prds-archived/');

  const auditEntry = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).reverse()
    .find((e) => e.kind === 'needs_review_gate_resolved' && e.slug === t.slug);
  assert.ok(auditEntry, 'needs_review_gate_resolved audit record written');
  assert.equal(auditEntry.verdict, 'transcript_errors');
});

test('gate authority: red re-run leaves the row at needs_review, untouched', async () => {
  const t = setup('authRed', ac('timeout 30 node -e "process.exit(3)"'));
  t.job.landedCommit = headSha(t.cwd);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'red');
  assert.deepEqual(rec.authority, { complete: false, reason: 'gate-not-green' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'transcript_errors');
});

test('gate authority: a verdict outside the eligible set is never considered, even with a landed commit and a green gate', async () => {
  const t = setup('authIneligible', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  t.job.verifierVerdict = 'shared_tree_reverted';
  persistJob(t);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.equal(rec.authority, undefined, 'decideGateAuthority never runs for an ineligible verdict');

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
  assert.equal(row.verifierVerdict, 'shared_tree_reverted');
});

test('gate authority: a real commit on a side branch, not on HEAD, blocks completion', async () => {
  const t = setup('authNotAncestor', ac('timeout 30 node -e "process.exit(0)"'));
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], t.cwd).trim();
  git(['checkout', '-q', '-b', 'side'], t.cwd);
  fs.writeFileSync(path.join(t.cwd, 'side.txt'), 'x\n');
  // Stage only the new file — `-A` would also sweep up the untracked
  // session-manager-operations/ tree (the PRD + queue.json setup() wrote),
  // and checking back out would then delete it: it's tracked on `side` but
  // absent from the original branch's tree.
  git(['add', 'side.txt'], t.cwd);
  git(['commit', '-q', '-m', 'side commit'], t.cwd);
  const sideSha = headSha(t.cwd); // real, resolvable commit — just not on HEAD
  git(['checkout', '-q', branch], t.cwd);
  t.job.landedCommit = sideSha;

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: false, reason: 'commit-not-on-head' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

test('gate authority: a dirty tracked tree blocks completion', async () => {
  const t = setup('authDirty', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  fs.writeFileSync(path.join(t.cwd, 'README.md'), 'uncommitted change\n'); // tracked, left dirty

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: false, reason: 'tree-dirty' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

test('gate authority: the kill switch blocks completion of an otherwise fully-eligible row', async () => {
  const t = setup('authKillSwitch', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  const prior = process.env.SM_GATE_AUTHORITATIVE_DISABLE;
  process.env.SM_GATE_AUTHORITATIVE_DISABLE = '1';
  try {
    const rec = await runGateShadow(t.job);
    assert.equal(rec.status, 'green');
    assert.deepEqual(rec.authority, { complete: false, reason: 'kill-switch' });

    const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
    assert.equal(row.status, 'needs_review');
  } finally {
    if (prior === undefined) delete process.env.SM_GATE_AUTHORITATIVE_DISABLE;
    else process.env.SM_GATE_AUTHORITATIVE_DISABLE = prior;
  }
});

test('the trigger re-picks a row whose gateShadow is stale once HEAD has moved', async () => {
  const t = setup('authStale', ac('timeout 30 node -e "process.exit(0)"'));
  const oldHead = headSha(t.cwd);
  t.job.gateShadow = { status: 'red', head: oldHead, source: 'ac-line', ranAt: new Date().toISOString(), results: [] };

  // A sibling fix lands — HEAD moves past the stale shadow's head.
  fs.writeFileSync(path.join(t.cwd, 'extra.txt'), 'x\n');
  git(['add', '-A'], t.cwd);
  git(['commit', '-q', '-m', 'advance head'], t.cwd);
  t.job.landedCommit = headSha(t.cwd);
  persistJob(t);

  await reverifyNeedsReview();
  await awaitGateShadowIdle();

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.gateShadow.head, t.job.landedCommit, 'the trigger re-ran the shadow at the new HEAD, not the stale one');
  assert.equal(row.gateShadow.status, 'green');
  assert.equal(row.status, 'completed', 'the fresh green re-run completed it in the same pass');
});

// ─── Gate authority: this run's commit only (evidenceOk) ───────────────────

test('gate authority: no_verdict_sentinel also completes on a green re-run with a commit after startedAt', async () => {
  const t = setup('authNoVerdictSentinel', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.verifierVerdict = 'no_verdict_sentinel';
  t.job.landedCommit = headSha(t.cwd);
  persistJob(t);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: true, reason: 'gate-green' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'completed');
});

test('gate authority: abandoned_background_task also completes on a green re-run with a commit after startedAt', async () => {
  const t = setup('authAbandonedTask', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.verifierVerdict = 'abandoned_background_task';
  t.job.landedCommit = headSha(t.cwd);
  persistJob(t);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: true, reason: 'gate-green' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'completed');
});

test('gate authority: a landedCommit committed before startedAt is refused as not from this run', async () => {
  const t = setup('authStaleCommit', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd); // the init commit
  t.job.startedAt = new Date(Date.now() + 60_000).toISOString(); // forward of the init commit — an older run's commit
  persistJob(t);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: false, reason: 'commit-not-from-this-run' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

test('gate authority: a missing startedAt is refused as not from this run', async () => {
  const t = setup('authNoStartedAt', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  delete t.job.startedAt;
  persistJob(t);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: false, reason: 'commit-not-from-this-run' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

// ─── Gate authority: bound to the exact tree the gate ran on ───────────────

test('gate authority: an untracked file blocks completion and is not definitive', async () => {
  const t = setup('authUntracked', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  fs.writeFileSync(path.join(t.cwd, 'untracked.txt'), 'new, never committed\n');

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.equal(rec.definitive, false);
  assert.deepEqual(rec.authority, { complete: false, reason: 'tree-dirty' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

test('gate authority: the gate command itself dirtying a tracked file blocks completion and is not definitive', async () => {
  const name = 'authDirtiesDuringGate';
  const cwd = path.join(tmpHome, name); // setup() computes the identical path internally
  const t = setup(name, ac(`timeout 30 node '${dirtyFileScript}' '${path.join(cwd, 'README.md')}'`));
  t.job.landedCommit = headSha(t.cwd);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.equal(rec.definitive, false);
  assert.deepEqual(rec.authority, { complete: false, reason: 'tree-dirty' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

test('gate authority: the gate command making a commit moves HEAD and blocks completion', async () => {
  const t = setup('authHeadMovesDuringGate', ac('timeout 30 git commit --allow-empty -q -m midgate'));
  t.job.landedCommit = headSha(t.cwd);

  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'green');
  assert.equal(rec.definitive, false);
  assert.deepEqual(rec.authority, { complete: false, reason: 'head-moved-during-gate' });

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review');
});

// ─── Memoization: only a definitive result is trusted without re-running ───

test('memo: a non-definitive refusal at an unchanged HEAD is re-run on the next call, not skipped', async () => {
  const t = setup('memoNonDefinitive', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  fs.writeFileSync(path.join(t.cwd, 'untracked.txt'), 'x\n'); // keeps the tree dirty across both calls

  const rec1 = await runGateShadow(t.job);
  assert.equal(rec1.definitive, false);
  t.job.gateShadow = rec1; // the row now carries forward exactly what was just recorded

  const rec2 = await runGateShadow(t.job);
  assert.ok(rec2, 'a non-definitive memo must not short-circuit the next call to null');
  assert.equal(rec2.definitive, false);
});

test('memo: a definitive red at an unchanged HEAD short-circuits the next call to null', async () => {
  const t = setup('memoDefinitiveRed', ac('timeout 30 node -e "process.exit(3)"'));
  t.job.landedCommit = headSha(t.cwd);

  const rec1 = await runGateShadow(t.job);
  assert.equal(rec1.status, 'red');
  assert.equal(rec1.definitive, true);
  t.job.gateShadow = rec1;

  const rec2 = await runGateShadow(t.job);
  assert.equal(rec2, null, 'a definitive result at the same HEAD is not re-run');
});

// ─── Final mutate: drop the result if the row changed under the gate ───────

test('gate authority: a runId change under the gate drops the result entirely, no gateShadow written', async () => {
  const t = setup('authRunIdChangesUnderGate', ac('timeout 30 node -e "process.exit(0)"'));
  t.job.landedCommit = headSha(t.cwd);
  const jobSnapshot = { ...t.job };

  // Simulate the row being re-dispatched (new runId + startedAt) while the
  // shadow gate for the OLD snapshot is still in flight: this mutate lands on
  // disk before runGateShadow's own final mutate reads the row back.
  t.job.runId = 'a-different-run';
  t.job.startedAt = new Date().toISOString();
  persistJob(t);

  const rec = await runGateShadow(jobSnapshot);
  assert.equal(rec.status, 'green');
  assert.deepEqual(rec.authority, { complete: true, reason: 'gate-green' }, 'the decision is still computed for the snapshot it ran against');

  const row = JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);
  assert.equal(row.status, 'needs_review', 'the live row (new dispatch) is untouched');
  assert.equal(row.runId, 'a-different-run');
  assert.equal('gateShadow' in row, false, 'the stale result is dropped entirely, not written onto the new dispatch');
});
