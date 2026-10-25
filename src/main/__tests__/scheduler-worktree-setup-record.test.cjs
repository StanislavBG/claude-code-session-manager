/**
 * scheduler-worktree-setup-record.test.cjs — executeJob records the worktree
 * setup outcome in the run log and every meta.json.
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let executeJob;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-setup-record-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../scheduler.cjs'));
});
afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
afterEach(() => { delete process.env.SM_CLAUDE_BIN; });

async function run(setup) {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-setup-main-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-setup-run-'));
  try {
    const slug = `setup-rec-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'do it', 'utf8');
    process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
      process.exit(0);
    ` });
    const args = [{ slug, cwd: mainCwd }, runDir, mainCwd, () => Promise.resolve(), undefined, null, null, null, null, true];
    if (setup !== undefined) args.push(setup);
    const res = await executeJob(...args);
    expect(res.exitCode).toBe(0);
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${slug}.meta.json`), 'utf8'));
    const logFile = fs.readdirSync(runDir).find((f) => f.endsWith('.log'));
    const log = fs.readFileSync(path.join(runDir, logFile), 'utf8');
    return { meta, log };
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

const passed = { ran: true, ok: true, reason: 'passed', waitedMs: 0, ms: 1200, commands: [{ cmd: 'npm ci', code: 0, ms: 1100, timedOut: false, tail: '' }] };
const failed = { ran: true, ok: false, reason: 'failed', waitedMs: 0, ms: 50, commands: [{ cmd: 'npm ci', code: 7, ms: 40, timedOut: false, tail: 'boom' }] };
const inPlace = { ran: false, ok: false, reason: 'in-place', waitedMs: 0, ms: 0, commands: [] };

test('passed outcome: lines precede spawn line and meta carries it', async () => {
  const { meta, log } = await run(passed);
  const at = log.indexOf('worktree setup:');
  expect(at).toBeGreaterThan(-1);
  expect(at).toBeLessThan(log.indexOf('[scheduler] spawned pid='));
  expect(log.indexOf('[scheduler] cwd=')).toBeLessThan(at);
  expect(meta.worktreeSetup).toEqual(passed);
});

test('failed outcome: log shows the exit code', async () => {
  const { meta, log } = await run(failed);
  expect(log).toMatch(/exit 7/);
  expect(meta.worktreeSetup).toEqual(failed);
});

test('no argument: no setup line and no worktreeSetup key', async () => {
  const { meta, log } = await run(undefined);
  expect(log).not.toContain('worktree setup:');
  expect('worktreeSetup' in meta).toBe(false);
});

test('in-place: no log line but recorded in meta', async () => {
  const { meta, log } = await run(inPlace);
  expect(log).not.toContain('worktree setup:');
  expect(meta.worktreeSetup).toEqual(inPlace);
});
