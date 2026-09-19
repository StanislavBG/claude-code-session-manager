/**
 * scheduler-supervisor-record.test.cjs — executeJob writes
 * <runDir>/<slug>.supervisor.json synchronously at the `spawned pid=` point,
 * i.e. before the child's first output and before onPid's mutate runs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-supervisor-record.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let executeJob;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-supervisor-rec-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../scheduler.cjs'));
});
afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
afterEach(() => { delete process.env.SM_CLAUDE_BIN; });

function writeSlowStub() {
  const stubPath = path.join(os.tmpdir(), `sm-sup-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
      process.exit(0);
    }, 500);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

test('the supervisor record exists by the time onPid fires, before the child prints anything', async () => {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sup-main-'));
  const worktreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sup-wt-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-sup-run-'));
  try {
    const slug = `sup-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'body', 'utf8');
    process.env.SM_CLAUDE_BIN = writeSlowStub();

    const seen = {};
    const result = await executeJob({ slug, cwd: mainCwd }, runDir, mainCwd, (pid) => {
      const file = path.join(runDir, `${slug}.supervisor.json`);
      seen.exists = fs.existsSync(file);
      seen.record = seen.exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      seen.pid = pid;
      seen.logHasOutput = fs.readFileSync(path.join(runDir, `${slug}.log`), 'utf8').includes('"type":"result"');
      seen.metaExists = fs.existsSync(path.join(runDir, `${slug}.meta.json`));
      return Promise.resolve();
    }, worktreeCwd);

    expect(result.exitCode).toBe(0);
    expect(seen.exists).toBe(true);
    expect(seen.logHasOutput).toBe(false);
    expect(seen.metaExists).toBe(false);
    expect(seen.record).toMatchObject({
      kind: 'job', slug, cwd: mainCwd, runId: path.basename(runDir), pid: seen.pid, pgid: seen.pid,
      execCwd: worktreeCwd, worktreeDir: worktreeCwd, worktreeBranch: `sm-job/${slug}`, schedulerPid: process.pid,
    });
    expect(typeof seen.record.startedAt).toBe('number');
    expect(seen.record.idleKillMs).toBeGreaterThan(0);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(worktreeCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
