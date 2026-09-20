/**
 * scheduler-shard-quarantine.test.cjs — a torn per-project queue shard
 * quarantines THAT project only. tickQueue keeps dispatching the healthy
 * project, never scans/mints rows for the torn project's PRDs, never touches
 * the torn file, and health names the quarantined cwd (non-GREEN).
 *
 * Everything runs under a temp HOME; the stub `claude` writes a marker into
 * its own cwd so the test can prove where a spawn did (not) happen.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-shard-quarantine.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let originalWt;
let scheduler;

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function makeProject(name) {
  const cwd = path.join(tmpHome, 'Projects', name);
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'fixture-epic', 'prds');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(prdsDir, { recursive: true });
  registerActiveProject(cwd);
  return { cwd, prdsDir, queueFile: path.join(stateDir, 'queue.json') };
}

function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    require('fs').writeFileSync(require('path').join(process.cwd(), 'ran-here.marker'), 'yes');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
}

beforeAll(() => {
  originalHome = process.env.HOME;
  originalWt = process.env.SM_JOB_WORKTREE_DISABLE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-shard-quarantine-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  scheduler = require('../scheduler.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalWt === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalWt;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_BIN;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('tickQueue dispatches the healthy project while the torn project is skipped; health names it', async () => {
  const good = makeProject('good-proj');
  const torn = makeProject('torn-proj');
  const goodSlug = `9101-good-${process.pid}`;
  const tornSlug = `9102-torn-${process.pid}`;
  fs.writeFileSync(path.join(good.prdsDir, `${goodSlug}.md`), 'Healthy PRD.', 'utf8');
  fs.writeFileSync(path.join(torn.prdsDir, `${tornSlug}.md`), 'PRD in the torn project.', 'utf8');
  fs.writeFileSync(good.queueFile, JSON.stringify({
    jobs: [{ slug: goodSlug, title: 'good', status: 'pending', cwd: good.cwd, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
  // A running row was in flight when the shard tore — must never become pending.
  const TORN = '{"jobs":[{"slug":"' + tornSlug + '","status":"running"}]}{"jobs":[{"slug":"';
  fs.writeFileSync(torn.queueFile, TORN);
  const before = fs.readFileSync(torn.queueFile);
  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  const result = await scheduler.tickQueue({ bypassLoadGate: true });
  expect(result.reason).not.toBe('unreadable');
  expect(result.fired).toBe(true);
  // flagUnreadable (via tickQueue's readQueue) snapshots the torn shard beside itself.
  const snaps = fs.readdirSync(path.dirname(torn.queueFile)).filter((f) => f.startsWith('queue.json.corrupt-'));
  expect(snaps).toHaveLength(1);

  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (fs.existsSync(path.join(good.cwd, 'ran-here.marker'))) return resolve();
      if (Date.now() - t0 > 20_000) return reject(new Error('healthy project never dispatched'));
      setTimeout(poll, 100);
    };
    poll();
  });

  expect(fs.existsSync(path.join(torn.cwd, 'ran-here.marker'))).toBe(false);
  expect(fs.readFileSync(torn.queueFile).equals(before)).toBe(true);

  const health = await require('../health.cjs').check({ skipTypecheck: true });
  expect(health.components.scheduler_queue.ok).toBe(false);
  expect(health.components.scheduler_queue.quarantinedCwds).toEqual([torn.cwd]);
  expect(health.issues.some((i) => i.includes(torn.cwd))).toBe(true);
}, 120_000); // skipTypecheck: this asserts scheduler_queue only; tsc was the tens of seconds
