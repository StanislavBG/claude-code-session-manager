/**
 * check-epic-transcripts.test.cjs — mislocated / duplicated / clean cases and exit codes.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/check-epic-transcripts.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeCwd } = require('../../src/main/lib/encodeCwd.cjs');

const SCRIPT = path.resolve(__dirname, '../check-epic-transcripts.cjs');
let home;

function mkProject(name, epics) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ect-${name}-`)));
  const ops = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(ops, { recursive: true });
  fs.writeFileSync(path.join(ops, 'active-index.json'), JSON.stringify({ sessions: epics }));
  return cwd;
}
function transcript(dirCwd, sid, cwdRow) {
  const d = path.join(home, '.claude', 'projects', encodeCwd(dirCwd));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sid}.jsonl`), `${JSON.stringify({ cwd: cwdRow })}\n`);
}
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ect-home-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('clean project exits 0', () => {
  const cwd = mkProject('clean', { e1: { claudeSessionId: 'sid-clean' } });
  transcript(cwd, 'sid-clean', cwd);
  const r = run();
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(run('--json').stdout)).toEqual([]);
});

test('mislocated + duplicated reported, exit 1, --json is only the array', () => {
  const wtA = '/tmp/session-manager-epic-worktrees/aaa';
  const wtB = '/tmp/session-manager-epic-worktrees/bbb';
  const cwd = mkProject('bad', {
    e1: { claudeSessionId: 'sid-mis', worktree: { dir: wtA } },
    e2: { claudeSessionId: 'sid-dup', worktree: { dir: wtB } },
    e3: {},
  });
  transcript(wtA, 'sid-mis', cwd);
  transcript(wtB, 'sid-dup', cwd);
  transcript(cwd, 'sid-dup', cwd);
  const r = run('--json');
  expect(r.status).toBe(1);
  const out = JSON.parse(r.stdout);
  const by = Object.fromEntries(out.map((f) => [f.sessionId, f]));
  expect(by['sid-mis'].classification).toBe('mislocated');
  expect(by['sid-mis'].paths).toHaveLength(1);
  expect(by['sid-dup'].classification).toBe('duplicated');
  expect(by['sid-dup'].paths).toHaveLength(2);
  expect(by['sid-dup'].epicId).toBe('e2');
  const text = run();
  expect(text.status).toBe(1);
  expect(text.stdout).toMatch(/mislocated.*sid-mis/);
});

test('project with unreadable index is skipped without throwing', () => {
  const cwd = mkProject('broken', {});
  fs.writeFileSync(path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'), '{nope');
  transcript(cwd, 'x', cwd);
  expect(run().status).toBe(0);
});

test('archived per-Epic record is scanned too', () => {
  const wt = '/tmp/session-manager-epic-worktrees/arch';
  const cwd = mkProject('arch', {});
  const ops = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.writeFileSync(path.join(ops, 'old-epic-1.json'), JSON.stringify({ session: { claudeSessionId: 'sid-arch', worktree: { dir: wt } } }));
  transcript(wt, 'sid-arch', cwd);
  const out = JSON.parse(run('--json').stdout);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ sessionId: 'sid-arch', epicId: 'old-epic-1', classification: 'mislocated' });
});
