/**
 * scheduler-gate-shadow.test.cjs — the shadow gate records `gateShadow` on the
 * verdicts sidecar and the row, and NEVER changes a status.
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

const { runGateShadow } = require('../scheduler.cjs');
const { runGateSequence } = require('../lib/definitionOfDone.cjs');
const { resolveEpicPrdWriteDir } = require('../lib/prdLocations.cjs');
const { bustCwdCache } = require('../lib/queueStore.cjs');

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

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
  const job = { slug, status: 'needs_review', cwd, runId, verifierVerdict: 'transcript_errors', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  fs.writeFileSync(queuePath, JSON.stringify({ jobs: [job] }, null, 2));
  return { cwd, slug, job, verdictsPath, queuePath };
}

const ac = (cmd) => `# Acceptance criteria\n\n- [ ] Gate: \`${cmd}\`\n`;

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
