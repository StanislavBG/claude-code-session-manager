/**
 * epicTranscriptPath.test.cjs — resolver for where an Epic session's JSONL
 * transcript actually lives (worktree encoding vs project encoding).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicTranscriptPath.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveEpicTranscriptPath, __resetCacheForTests } = require('../epicTranscriptPath.cjs');
const { encodeCwd } = require('../encodeCwd.cjs');
const { readActiveIndex } = require('../epicMint.cjs');

const SID = 'sess-1';
let root, home, cwd, wtDir;

const projFile = (dir) => path.join(home, '.claude', 'projects', encodeCwd(dir), `${SID}.jsonl`);
function put(p, body = '{"a":1}\n', mtimeSec) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtimeSec) fs.utimesSync(p, mtimeSec, mtimeSec);
}
const promptDir = () => path.join(cwd, 'session-manager-operations', 'prompt-sessions');
function writeIndex(sessions) {
  fs.mkdirSync(promptDir(), { recursive: true });
  fs.writeFileSync(path.join(promptDir(), 'active-index.json'), JSON.stringify({ sessions, events: {} }));
}
const epic = (extra = {}) => ({ id: 'epic-1', claudeSessionId: SID, worktree: { dir: wtDir, branch: 'b', baseCwd: cwd, status: 'active' }, ...extra });
const resolve = (deps = {}) => resolveEpicTranscriptPath({ cwd, claudeSessionId: SID, deps: { homeDir: home, ...deps } });

beforeEach(() => {
  __resetCacheForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-etp-'));
  home = path.join(root, 'home');
  cwd = path.join(root, 'project');
  wtDir = path.join(root, 'wt', 'epic-1');
  fs.mkdirSync(cwd, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('worktree transcript is found when the worktree dir exists', () => {
  fs.mkdirSync(wtDir, { recursive: true });
  writeIndex({ e: epic() });
  put(projFile(wtDir));
  const r = resolve();
  expect(r.path).toBe(projFile(wtDir));
  expect(r.existsAnywhere).toBe(true);
  expect(r.candidates).toEqual([projFile(wtDir), projFile(cwd)]);
});

test('worktree swept from disk but transcript survives — still returned', () => {
  writeIndex({ e: epic() });
  put(projFile(wtDir));
  const r = resolve();
  expect(r.path).toBe(projFile(wtDir));
  expect(r.candidates).toContain(projFile(wtDir));
});

test('project-encoding-only transcript', () => {
  fs.mkdirSync(wtDir, { recursive: true });
  writeIndex({ e: epic() });
  put(projFile(cwd));
  const r = resolve();
  expect(r.path).toBe(projFile(cwd));
  expect(r.existingPaths).toEqual([projFile(cwd)]);
});

test('nothing anywhere: path is the spawn-cwd candidate, existsAnywhere false', () => {
  fs.mkdirSync(wtDir, { recursive: true });
  writeIndex({ e: epic() });
  const r = resolve();
  expect(r.path).toBe(projFile(wtDir));
  expect(r.existsAnywhere).toBe(false);
  expect(r.existingPaths).toEqual([]);
});

test('non-Epic tab returns exactly the project path with a single candidate', () => {
  writeIndex({ e: epic({ claudeSessionId: 'other' }) });
  put(projFile(cwd));
  const r = resolve();
  expect(r.candidates).toEqual([projFile(cwd)]);
  expect(r.path).toBe(projFile(cwd));
});

test('dir exists but holds only a tool-results sidecar — does not win', () => {
  fs.mkdirSync(wtDir, { recursive: true });
  writeIndex({ e: epic() });
  fs.mkdirSync(path.join(path.dirname(projFile(wtDir)), SID, 'tool-results'), { recursive: true });
  put(projFile(cwd));
  const r = resolve();
  expect(r.path).toBe(projFile(cwd));
  expect(r.existingPaths).toEqual([projFile(cwd)]);
});

test('a directory named <id>.jsonl is not a transcript', () => {
  writeIndex({ e: epic() });
  fs.mkdirSync(projFile(wtDir), { recursive: true });
  expect(resolve().existsAnywhere).toBe(false);
});

test('zero-byte file counts as existing but loses to a non-empty one', () => {
  fs.mkdirSync(wtDir, { recursive: true });
  writeIndex({ e: epic() });
  put(projFile(wtDir), '');
  let r = resolve();
  expect(r.existsAnywhere).toBe(true);
  expect(r.path).toBe(projFile(wtDir));
  put(projFile(cwd), '{"a":1}\n', 1000);
  r = resolve();
  expect(r.path).toBe(projFile(cwd));
  expect(r.existingPaths.length).toBe(2);
});

test('duplicate under two encodings: newest mtime wins', () => {
  fs.mkdirSync(wtDir, { recursive: true });
  writeIndex({ e: epic() });
  put(projFile(wtDir), 'x\n', 2000);
  put(projFile(cwd), 'x\n', 3000);
  let r = resolve();
  expect(r.existingPaths.length).toBe(2);
  expect(r.path).toBe(projFile(cwd));
  put(projFile(wtDir), 'x\n', 4000);
  r = resolve();
  expect(r.path).toBe(projFile(wtDir));
});

test('completed Epic (absent from index) resolved from its archive', () => {
  writeIndex({});
  fs.writeFileSync(path.join(promptDir(), 'done-epic-abcd1234.json'), JSON.stringify({ session: epic(), events: [], transcript: '', archivedAt: 'x' }));
  put(projFile(wtDir));
  const r = resolve();
  expect(r.path).toBe(projFile(wtDir));
});

test('malformed archive JSON and unreadable index never throw', () => {
  writeIndex({});
  fs.writeFileSync(path.join(promptDir(), 'bad.json'), '{not json');
  expect(() => resolve()).not.toThrow();
  const r = resolve({ readActiveIndex: () => { throw new Error('boom'); } });
  expect(r.candidates).toEqual([projFile(cwd)]);
});

test('blank/missing/unsafe inputs return a safe result', () => {
  for (const args of [{}, { cwd: '', claudeSessionId: SID }, { cwd, claudeSessionId: '' }, { cwd, claudeSessionId: '../x' }]) {
    const r = resolveEpicTranscriptPath({ ...args, deps: { homeDir: home } });
    expect(r).toEqual({ path: null, candidates: [], existsAnywhere: false, existingPaths: [] });
  }
});

test('index read once across N calls when unchanged; re-read after a touch', () => {
  writeIndex({ e: epic() });
  let reads = 0;
  const deps = { readActiveIndex: (c) => { reads++; return readActiveIndex(c); } };
  for (let i = 0; i < 20; i++) resolve(deps);
  expect(reads).toBe(1);
  writeIndex({ e: epic(), f: epic({ id: 'epic-2', claudeSessionId: 'zzz' }) });
  resolve(deps);
  expect(reads).toBe(2);
});
