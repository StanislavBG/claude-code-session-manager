/**
 * preflightParkReroute.test.cjs — a run with a `preflight` that ends in an
 * executor SCHEDULER_VERDICT: FAIL re-checks the preflight once. Red → back to
 * pending with a preflightHold and nothing spent on the model ladder; green or
 * no preflight → the ordinary needs_review park; a held fix-plan child is
 * never reopened by the dead-fix-plan path.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/preflightParkReroute.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let sched;
let reviewLadder;

const MIN = 60_000;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function queuePath(projectCwd) {
  return path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
}

function mkProject(rows) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-preflight-reroute-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  for (const r of rows) {
    const fm = r.preflight ? `---\npreflight: ${JSON.stringify(r.preflight)}\n---\n` : '';
    fs.writeFileSync(path.join(prdsDir, `${r.slug}.md`), `${fm}Preflight test.`, 'utf8');
  }
  fs.mkdirSync(path.dirname(queuePath(projectCwd)), { recursive: true });
  fs.writeFileSync(queuePath(projectCwd), JSON.stringify({
    jobs: rows.map((r) => ({ status: 'pending', cwd: projectCwd, agentType: 'dev-lead', ...r })),
  }, null, 2));
  return projectCwd;
}

function readRow(projectCwd, slug) {
  return JSON.parse(fs.readFileSync(queuePath(projectCwd), 'utf8')).jobs.find((j) => j.slug === slug);
}

function runDirFor(runId) {
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function auditEvents(type) {
  const dir = path.join(tmpHome, '.claude', 'session-manager');
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/audit.*\.jsonl$/.test(e.name)) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const ev = JSON.parse(line); if (ev.type === type || ev.event === type || ev.kind === type) out.push(ev); } catch { /* skip */ }
        }
      }
    }
  };
  walk(dir);
  return out;
}

function uniq(tag) {
  return `3748-${tag}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
}


// Stub: breaks the precondition when `brokenFile` is given (an absolute path
// the preflight checks), commits what it could (finish protocol: "do
// everything else, commit it"), then reports an executor FAIL.
function stubFailRun(brokenFile) {
  const breakIt = brokenFile ? `require('fs').writeFileSync(${JSON.stringify(brokenFile)}, 'x');` : '';
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({
    allowCommitUnder: os.tmpdir(),
    body: `${breakIt}
require('fs').writeFileSync('partial.txt', 'partial work\\n');
runGit(['add', 'partial.txt']);
runGit(['commit', '-q', '-m', 'feat: partial work']);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'could not finish\\nSCHEDULER_VERDICT: FAIL store agreement not signed' }) + '\\n');
process.exit(0);`,
  });
}

// Preflight: exits 3 once `broken.flag` exists in the project cwd.
const PREFLIGHT = `node -e "process.exit(require('fs').existsSync('broken.flag')?3:0)"`;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-preflight-reroute-home-'));
  process.env.HOME = tmpHome;
  sched = require('../scheduler.cjs');
  reviewLadder = require('../scheduler/reviewLadder.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  delete process.env.SM_AUTOFIX_DISABLE;
});

async function runFail({ tag, preflight, breakPrecondition }) {
  const slug = uniq(tag);
  const projectCwd = mkProject([{ slug, ...(preflight ? { preflight } : {}) }]);
  stubFailRun(breakPrecondition ? path.join(projectCwd, 'broken.flag') : null);
  const runId = `run-${slug}`;
  const runDir = runDirFor(runId);
  await sched.spawnJob({ slug, cwd: projectCwd, agentType: 'dev-lead', status: 'pending', ...(preflight ? { preflight } : {}) }, runId, runDir, projectCwd);
  return { slug, projectCwd, runDir, row: readRow(projectCwd, slug) };
}

function cleanup(r) {
  fs.rmSync(r.projectCwd, { recursive: true, force: true });
  fs.rmSync(r.runDir, { recursive: true, force: true });
}

test('red preflight after a FAIL run → pending + hold, no park, no investigation', async () => {
  const r = await runFail({ tag: 'red', preflight: PREFLIGHT, breakPrecondition: true });
  try {
    expect(r.row.status).toBe('pending');
    expect(r.row.preflightHold).toBeTruthy();
    expect(r.row.preflightHold.attempts).toBe(1);
    expect(r.row.preflightHold.lastExit).toBe(3);
    expect(r.row.preflightHold.failText).toContain('SCHEDULER_VERDICT: FAIL');
    expect(r.row.preflightHold.failText).toContain('store agreement not signed');
    expect(r.row.heldReason).toBe(`waiting on precondition: ${PREFLIGHT} exited 3 — re-check at ${r.row.preflightHold.nextAt}`);
    const last = (r.row.statusHistory || []).at(-1);
    if (last) expect(JSON.stringify(last)).toContain('scheduler:preflight-hold');
    // Nothing spent on the ladder.
    expect(r.row.autoFixAttempted).toBeUndefined();
    expect(r.row.verifyRefireCount).toBeUndefined();
    expect(r.row.verifierVerdict).toBeUndefined();
    const ev = auditEvents('preflight_hold').find((e) => JSON.stringify(e).includes(r.slug));
    expect(ev).toBeTruthy();
    // The held row never becomes an investigation.
    const res = await sched.spawnInvestigation(r.row, r.runDir);
    expect(res).toEqual({ deferred: false });
    expect(readRow(r.projectCwd, r.slug).status).toBe('pending');
  } finally {
    cleanup(r);
  }
}, 120_000);

test('green preflight after a FAIL run → needs_review sentinel_fail as before', async () => {
  process.env.SM_AUTOFIX_DISABLE = '1';
  const r = await runFail({ tag: 'green', preflight: PREFLIGHT, breakPrecondition: false });
  try {
    expect(r.row.status).toBe('needs_review');
    expect(r.row.verifierVerdict).toBe('sentinel_fail');
    expect(r.row.preflightHold).toBeUndefined();
    expect(auditEvents('preflight_hold').some((e) => JSON.stringify(e).includes(r.slug))).toBe(false);
  } finally {
    cleanup(r);
  }
}, 120_000);

test('a row without preflight → needs_review sentinel_fail as before', async () => {
  process.env.SM_AUTOFIX_DISABLE = '1';
  const r = await runFail({ tag: 'none', preflight: null, breakPrecondition: false });
  try {
    expect(r.row.status).toBe('needs_review');
    expect(r.row.verifierVerdict).toBe('sentinel_fail');
    expect(r.row.preflightHold).toBeUndefined();
  } finally {
    cleanup(r);
  }
}, 120_000);

test('a held fix-plan child is not reopened by the dead-fix-plan path', () => {
  const parent = { slug: '900-parent', status: 'needs_review', autoFixOutcome: 'plan' };
  const fixSlug = reviewLadder.fixSlugFor(parent);
  const deadChild = { slug: fixSlug, status: 'skipped' };
  expect(reviewLadder.isFixPlanDead(parent, [parent, deadChild])).toBe(true);
  const heldChild = { ...deadChild, preflightHold: { attempts: 1, nextAt: new Date(Date.now() + MIN).toISOString() } };
  expect(reviewLadder.isFixPlanDead(parent, [parent, heldChild])).toBe(false);
  expect(reviewLadder.hasActivePreflightHold(heldChild)).toBe(true);
  expect(reviewLadder.hasActivePreflightHold(deadChild)).toBe(false);
});
