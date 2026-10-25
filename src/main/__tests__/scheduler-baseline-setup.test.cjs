/**
 * scheduler-baseline-setup.test.cjs — the baseline scratch worktree records the
 * project's worktree-setup outcome as gateShadow.baseline.setup, and a base
 * whose declared setup did not pass is 'unavailable' (never completes a row).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-setup-test-'));
process.env.HOME = tmpHome;
process.env.SM_AUTOFIX_DISABLE = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('SM_') && k !== 'SM_AUTOFIX_DISABLE') delete process.env[k];

const { runGateShadow } = require('../scheduler.cjs');
const { resolveEpicPrdWriteDir } = require('../lib/prd/prdLocations.cjs');
const { bustCwdCache } = require('../lib/scheduler/queueStore.cjs');

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

function setup(name, baseConfig) {
  const cwd = path.join(tmpHome, name);
  fs.mkdirSync(cwd, { recursive: true });
  git(['init', '-q'], cwd);
  git(['config', 'user.email', 't@example.com'], cwd);
  git(['config', 'user.name', 'T'], cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'x\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'session-manager-operations/\n');
  if (baseConfig) fs.writeFileSync(path.join(cwd, '.session-manager.json'), JSON.stringify(baseConfig));
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', 'base'], cwd);
  const base = git(['rev-parse', 'HEAD'], cwd).trim();
  fs.writeFileSync(path.join(cwd, 'README.md'), 'y\n');
  git(['commit', '-q', '-am', 'landed'], cwd);
  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  const slugDir = path.join(tmpHome, '.claude', 'projects', `${name}-slug`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 't.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();
  const prdDir = resolveEpicPrdWriteDir(cwd, 'gate-epic');
  fs.mkdirSync(prdDir, { recursive: true });
  const slug = `01-${name}`;
  fs.writeFileSync(path.join(prdDir, `${slug}.md`),
    `---\ntitle: T\ncwd: ${cwd}\nestimateMinutes: 5\n---\n# Acceptance criteria\n\n- [ ] Gate: \`timeout 30 node -e "process.exit(3)"\`\n`);
  const runId = `run-${name}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${slug}.verdicts.json`), JSON.stringify({ verdict: 'sentinel_fail', reason: 'r' }));
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queuePath = path.join(stateDir, 'queue.json');
  const job = {
    slug, status: 'needs_review', cwd, runId, verifierVerdict: 'sentinel_fail',
    landedCommit: head, guardHeadBefore: base,
    startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(queuePath, JSON.stringify({ jobs: [job] }, null, 2));
  return { cwd, slug, job, queuePath };
}

const rowOf = (t) => JSON.parse(fs.readFileSync(t.queuePath, 'utf8')).jobs.find((j) => j.slug === t.slug);

afterEach(() => {
  fs.rmSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true, force: true });
  bustCwdCache();
});

test('passing committed setup is recorded on baseline.setup (ran + ok)', async () => {
  const t = setup('pass', { worktreeSetup: ['timeout 30 node -e "process.exit(0)"'] });
  const rec = await runGateShadow(t.job);
  assert.equal(rec.status, 'red');
  assert.equal(rec.baseline.setup.ran, true);
  assert.equal(rec.baseline.setup.ok, true);
  assert.equal(rowOf(t).gateShadow.baseline.setup.ok, true);
});

test('failing base setup makes the base unavailable; row stays needs_review', async () => {
  const t = setup('fail', { worktreeSetup: ['timeout 30 node -e "process.exit(4)"'] });
  const rec = await runGateShadow(t.job);
  assert.equal(rec.baseline.outcome.status, 'unavailable');
  assert.equal(rec.baseline.outcome.reason, 'base-setup-failed');
  assert.equal(rec.baseline.setup.ok, false);
  assert.equal(rowOf(t).status, 'needs_review');
});

test('no .session-manager.json: base gate runs as before (setup no-config)', async () => {
  const t = setup('noconf', null);
  const rec = await runGateShadow(t.job);
  assert.equal(rec.baseline.setup.reason, 'no-config');
  assert.equal(rec.baseline.outcome.status, 'red');
});
