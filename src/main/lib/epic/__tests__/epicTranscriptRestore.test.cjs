/**
 * epicTranscriptRestore.test.cjs — reachable / copied / sidecar / missing / invalid-id / never-overwrite.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicTranscriptRestore.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('../../util/encodeCwd.cjs');
const { writeSidecar } = require('../archivedTranscript.cjs');
const { __resetCacheForTests } = require('../epicTranscriptPath.cjs');
const { hasTranscriptSource, ensureEpicTranscriptReachable } = require('../epicTranscriptRestore.cjs');

const SID = '11ff31cb-56b6-421c-829c-012ef95b15e2';
const EPIC = 'epic-1';
const OLD_WT = '/tmp/session-manager-epic-worktrees/zzz/old-epic-1';
const SPAWN = '/tmp/restore-test-spawn-cwd';

let home;
let cwd;
let deps;
beforeEach(() => {
  __resetCacheForTests();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-proj-'));
  deps = { homeDir: home, readActiveIndex: () => ({ sessions: {} }) };
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${EPIC}.json`),
    JSON.stringify({ session: { id: EPIC, cwd, claudeSessionId: SID, worktree: { dir: OLD_WT } } }),
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const jsonl = (dir) => path.join(home, '.claude', 'projects', encodeCwd(dir), `${SID}.jsonl`);
function put(dir, text) {
  const f = jsonl(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
const args = (extra = {}) => ({ cwd, epicId: EPIC, claudeSessionId: SID, spawnCwd: SPAWN, deps, ...extra });

test('already reachable under spawn cwd => none, nothing written', () => {
  const f = put(SPAWN, '{"a":1}\n');
  const r = ensureEpicTranscriptReachable(args());
  expect(r).toEqual({ ok: true, path: f, restored: 'none' });
  expect(hasTranscriptSource({ cwd, epicId: EPIC, claudeSessionId: SID, spawnCwd: SPAWN, deps })).toBe(true);
});

test('reachable under project cwd => none', () => {
  const f = put(cwd, '{"a":1}\n');
  const r = ensureEpicTranscriptReachable(args());
  expect(r).toEqual({ ok: true, path: f, restored: 'none' });
  expect(fs.existsSync(jsonl(SPAWN))).toBe(false);
});

test('only under old worktree encoding => copied, source unchanged', () => {
  const src = put(OLD_WT, '{"old":true}\n');
  const r = ensureEpicTranscriptReachable(args());
  expect(r).toEqual({ ok: true, path: jsonl(SPAWN), restored: 'copied' });
  expect(fs.readFileSync(jsonl(SPAWN), 'utf8')).toBe('{"old":true}\n');
  expect(fs.statSync(jsonl(SPAWN)).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(src, 'utf8')).toBe('{"old":true}\n');
});

test('no JSONL but sidecar => sidecar restore', () => {
  writeSidecar(cwd, EPIC, '{"side":1}\n');
  expect(hasTranscriptSource({ cwd, epicId: EPIC, claudeSessionId: SID, deps })).toBe(true);
  const r = ensureEpicTranscriptReachable(args());
  expect(r).toEqual({ ok: true, path: jsonl(SPAWN), restored: 'sidecar' });
  expect(fs.readFileSync(jsonl(SPAWN), 'utf8')).toBe('{"side":1}\n');
});

test('nothing anywhere => transcript_missing, nothing written', () => {
  expect(hasTranscriptSource({ cwd, epicId: EPIC, claudeSessionId: SID, deps })).toBe(false);
  const r = ensureEpicTranscriptReachable(args());
  expect(r.ok).toBe(false);
  expect(r.code).toBe('transcript_missing');
  expect(fs.existsSync(jsonl(SPAWN))).toBe(false);
});

test('invalid session id => invalid_session_id, no fs touch', () => {
  for (const bad of ['../evil', 'a/b', '', 'x'.repeat(129), null]) {
    const r = ensureEpicTranscriptReachable(args({ claudeSessionId: bad }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_session_id');
    expect(hasTranscriptSource({ cwd, epicId: EPIC, claudeSessionId: bad, deps })).toBe(false);
  }
  expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
});

test('never overwrites an existing non-empty target', () => {
  put(SPAWN, 'KEEP\n');
  put(OLD_WT, 'other\n');
  writeSidecar(cwd, EPIC, 'sidecar\n');
  const r = ensureEpicTranscriptReachable(args());
  expect(r.restored).toBe('none');
  expect(fs.readFileSync(jsonl(SPAWN), 'utf8')).toBe('KEEP\n');
});
