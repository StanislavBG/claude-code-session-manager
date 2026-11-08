/**
 * restorableSessions.test.cjs — the "Restore a session" lister: CLI transcripts
 * in ONE project dir that no Epic owns, plus the single-id check the mint path
 * reuses.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/restorableSessions.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const atomicFs = require('../../util/atomicFs.cjs');
const { encodeCwd } = require('../../util/encodeCwd.cjs');
const {
  SESSION_ID_RE,
  claimedClaudeSessionIds,
  claimedClaudeSessionIdsAsync,
  listRestorableSessions,
  checkRestorableSessionSync,
  __resetCacheForTests,
} = require('../restorableSessions.cjs');

const T0 = 1_700_000_000; // fixed mtimes (seconds) keep newest-first order deterministic
const KIB = 1024;
let root, home, cwd;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectDir = () => path.join(home, '.claude', 'projects', encodeCwd(cwd));
const transcript = (sid) => path.join(projectDir(), `${sid}.jsonl`);
const promptDir = () => path.join(cwd, 'session-manager-operations', 'prompt-sessions');
const deps = (extra = {}) => ({ homeDir: home, ...extra });
const list = ({ deps: extra, ...opts } = {}) => listRestorableSessions({ cwd, deps: deps(extra), ...opts });
const check = (id) => checkRestorableSessionSync(cwd, id, deps());
const ids = (r) => r.sessions.map((s) => s.sessionId);
const sorted = (set) => [...set].sort();

// Rows shaped like the CLI's: compact JSON, one per line, trailing newline.
const row = (extra) => ({ cwd, sessionId: 'x', entrypoint: 'cli', gitBranch: 'main', isSidechain: false, userType: 'external', ...extra });
const user = (content, extra = {}) => row({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (text) => row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** Assistant rows totalling at least `bytes` — pushes whatever follows out of a 64 KiB window. */
const filler = (bytes) => Array.from({ length: Math.ceil(bytes / (8 * KIB)) }, () => assistant('f'.repeat(8 * KIB)));

function writeTranscript(sid, rows, mtimeSec = T0) {
  const file = transcript(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

function writeSession(sid, { prompt = 'continue the refactor', entrypoint = 'cli', gitBranch = 'main', extra = [], mtimeSec = T0 } = {}) {
  return writeTranscript(sid, [
    { type: 'queue-operation', operation: 'dequeue', sessionId: sid },
    user(prompt, { entrypoint, gitBranch }),
    assistant('on it'),
    ...extra,
  ], mtimeSec);
}

function writeIndex(sessions) {
  fs.mkdirSync(promptDir(), { recursive: true });
  fs.writeFileSync(path.join(promptDir(), 'active-index.json'), JSON.stringify({ sessions, events: {} }));
}

function writeArchive(epicId, claudeSessionId, mtimeSec = T0) {
  fs.mkdirSync(promptDir(), { recursive: true });
  const file = path.join(promptDir(), `${epicId}.json`);
  fs.writeFileSync(file, JSON.stringify({ session: { id: epicId, claudeSessionId, status: 'completed' }, events: {}, status: 'completed' }));
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

beforeEach(() => {
  __resetCacheForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rs-'));
  home = path.join(root, 'home');
  cwd = path.join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test('SESSION_ID_RE accepts a hex UUID in either case and nothing else', () => {
  expect(SESSION_ID_RE.test(uuid(1))).toBe(true);
  expect(SESSION_ID_RE.test('0039BE43-163F-44F9-9B51-9A95D8AAD841')).toBe(true);
  for (const bad of ['', 'abc', `${uuid(1)}.jsonl`, `../${uuid(1)}`, `${uuid(1)}\n`, '0039be43-163f-44f9-9b51-9a95d8aad84g', '0039be43163f44f99b519a95d8aad841']) {
    expect(SESSION_ID_RE.test(bad)).toBe(false);
  }
});

test('lists unowned sessions newest first with picker metadata', async () => {
  writeSession(uuid(1), { prompt: 'older prompt', mtimeSec: T0 });
  writeSession(uuid(2), { prompt: '  newer prompt \n', gitBranch: 'feature/restore', mtimeSec: T0 + 60 });
  const size = (sid) => fs.statSync(transcript(sid)).size;
  expect(await list()).toEqual({
    sessions: [
      { sessionId: uuid(2), title: null, firstPrompt: 'newer prompt', lastPrompt: null, gitBranch: 'feature/restore', headless: false, mtimeMs: (T0 + 60) * 1000, sizeBytes: size(uuid(2)), recentlyActive: false },
      { sessionId: uuid(1), title: null, firstPrompt: 'older prompt', lastPrompt: null, gitBranch: 'main', headless: false, mtimeMs: T0 * 1000, sizeBytes: size(uuid(1)), recentlyActive: false },
    ],
    hiddenClaimed: 0,
    scanned: 2,
    truncated: false,
  });
});

test('a missing project dir lists nothing and checks not_found; non-UUID names and non-files are ignored', async () => {
  expect(await list()).toEqual({ sessions: [], hiddenClaimed: 0, scanned: 0, truncated: false });
  const missing = check(uuid(42));
  expect(missing).toMatchObject({ ok: false, code: 'not_found' });
  expect(missing.message).toContain(projectDir());
  expect(missing.message).toContain(uuid(42));

  writeSession(uuid(1));
  fs.writeFileSync(path.join(projectDir(), 'notes.jsonl'), '');
  fs.writeFileSync(path.join(projectDir(), `${uuid(2)}.json`), '');
  fs.mkdirSync(path.join(projectDir(), `${uuid(3)}.jsonl`));
  fs.mkdirSync(path.join(projectDir(), uuid(4))); // the CLI's per-session sidecar dir
  const r = await list();
  expect(ids(r)).toEqual([uuid(1)]);
  expect(r.scanned).toBe(1);
  expect(check(uuid(3))).toMatchObject({ ok: false, code: 'not_found' });
});

test('sessions an Epic owns (active-index or archived Epic file) are hidden, counted and refused', async () => {
  // Ownership compares case-folded: a case-insensitive fs maps both spellings to one transcript.
  const [lowerClaim, upperClaim] = ['abcdef01-2345-4678-9abc-def012345678', 'ABCDEF02-2345-4678-9ABC-DEF012345678'];
  writeSession(uuid(1), { mtimeSec: T0 + 5 });
  writeSession(uuid(2), { mtimeSec: T0 + 4 });
  writeSession(lowerClaim.toUpperCase(), { mtimeSec: T0 + 3 });
  writeSession(upperClaim.toLowerCase(), { mtimeSec: T0 + 2 });
  writeSession(uuid(3), { mtimeSec: T0 + 1 });
  writeIndex({
    'epic-live': { id: 'epic-live', claudeSessionId: uuid(1), status: 'active' },
    'epic-upper': { id: 'epic-upper', claudeSessionId: upperClaim, status: 'active' },
  });
  writeArchive('epic-done', uuid(2));
  writeArchive('epic-lower', lowerClaim);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual(sorted([uuid(1), uuid(2), lowerClaim, upperClaim]));

  const r = await list();
  expect(ids(r)).toEqual([uuid(3)]);
  expect(r).toMatchObject({ hiddenClaimed: 4, scanned: 1, truncated: false });

  for (const sid of [uuid(1), uuid(2), lowerClaim.toUpperCase(), upperClaim.toLowerCase()]) {
    const res = check(sid);
    expect(res).toMatchObject({ ok: false, code: 'claimed' });
    expect(res.message).toContain(sid);
    expect(res.message).toContain(projectDir());
  }
  expect(check(uuid(3))).toEqual({ ok: true, transcriptPath: transcript(uuid(3)) });
});

test('a transcript recorded in another cwd that encodes to the same dir is skipped and refused', async () => {
  // `<root>/my-proj` and `<root>/my/proj` share one ~/.claude/projects dir.
  cwd = path.join(root, 'my-proj');
  fs.mkdirSync(cwd, { recursive: true });
  const other = path.join(root, 'my', 'proj');
  expect(encodeCwd(other)).toBe(encodeCwd(cwd));
  writeTranscript(uuid(1), [user('from the sibling folder', { cwd: other })], T0 + 2);
  writeTranscript(uuid(2), [{ type: 'user', message: { role: 'user', content: 'no cwd recorded' } }], T0 + 1);
  writeSession(uuid(3));

  expect(ids(await list())).toEqual([uuid(3)]);
  const res = check(uuid(1));
  expect(res).toMatchObject({ ok: false, code: 'cwd_mismatch' });
  expect(res.message).toContain(other);
  expect(res.message).toContain(projectDir());
  expect(res.message).toContain(uuid(1));
  expect(check(uuid(2))).toMatchObject({ ok: false, code: 'cwd_mismatch' });
  expect(check(uuid(3))).toEqual({ ok: true, transcriptPath: transcript(uuid(3)) });
});

test('heads with no real user prompt are skipped; command and tool rows before a prompt are passed over', async () => {
  const toolResult = [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }];
  writeTranscript(uuid(1), [user('subagent task', { isSidechain: true })]);
  writeTranscript(uuid(2), [user([{ type: 'text', text: 'Base directory for this skill: …' }], { isMeta: true })]);
  writeTranscript(uuid(3), [
    user('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
    user('<local-command-stdout></local-command-stdout>'),
  ]);
  writeTranscript(uuid(4), [user(toolResult)]);
  writeTranscript(uuid(5), [user('   '), assistant('nobody asked')]);
  writeTranscript(uuid(6), [
    user('  <command-name>/model</command-name>'),
    user(toolResult),
    user([{ type: 'image', source: { type: 'base64', data: '' } }, { type: 'text', text: '  the real question  ' }]),
  ], T0 + 1);
  const r = await list();
  expect(r.sessions.map((s) => [s.sessionId, s.firstPrompt])).toEqual([[uuid(6), 'the real question']]);
  expect(r.scanned).toBe(6);
});

test('headless comes from an sdk-* entrypoint', async () => {
  writeSession(uuid(1), { entrypoint: 'sdk-cli', mtimeSec: T0 + 2 });
  writeSession(uuid(2), { entrypoint: 'sdk-ts', mtimeSec: T0 + 1 });
  writeSession(uuid(3), { entrypoint: 'cli' });
  const r = await list();
  expect(r.sessions.map((s) => [s.sessionId, s.headless])).toEqual([[uuid(1), true], [uuid(2), true], [uuid(3), false]]);
});

test('title is the last custom-title row, else the last summary row, from head or tail', async () => {
  writeSession(uuid(1), { mtimeSec: T0 + 4, extra: [
    { type: 'summary', summary: 'First summary', leafUuid: 'a' },
    { type: 'summary', summary: 'Latest summary', leafUuid: 'b' },
  ] });
  writeSession(uuid(2), { mtimeSec: T0 + 3, extra: [
    { type: 'custom-title', customTitle: 'Renamed by /rename', sessionId: uuid(2) },
    { type: 'summary', summary: 'Loses to the custom title', leafUuid: 'c' },
  ] });
  // Past 64 KiB: the custom title lives only in the tail window.
  writeSession(uuid(3), { mtimeSec: T0 + 2, extra: [...filler(100 * KIB), { type: 'custom-title', customTitle: 'Tail title', sessionId: uuid(3) }] });
  writeSession(uuid(4), { mtimeSec: T0 + 1 });
  const r = await list();
  expect(r.sessions.map((s) => s.title)).toEqual(['Latest summary', 'Renamed by /rename', 'Tail title', null]);
});

test('lastPrompt is the last last-prompt row in the tail; only the first and last 64 KiB are read', async () => {
  const lp = (text) => ({ type: 'last-prompt', lastPrompt: text, sessionId: 'x' });
  writeSession(uuid(1), { mtimeSec: T0 + 4, extra: [lp('earlier'), lp('latest')] }); // under 64 KiB: the head is the whole file
  writeSession(uuid(2), { mtimeSec: T0 + 3, extra: [lp('stale head copy'), ...filler(200 * KIB), lp('from the tail')] });
  writeSession(uuid(3), { mtimeSec: T0 + 2, extra: [...filler(100 * KIB), lp('mid-file, never read'), ...filler(100 * KIB)] });
  writeTranscript(uuid(4), [...filler(70 * KIB), user('prompt past the head window')], T0 + 1);
  const readFile = vi.spyOn(fs.promises, 'readFile');
  const readFileSync = vi.spyOn(fs, 'readFileSync');

  const r = await list();
  expect(r.sessions.map((s) => [s.sessionId, s.lastPrompt])).toEqual([[uuid(1), 'latest'], [uuid(2), 'from the tail'], [uuid(3), null]]);
  expect(r.scanned).toBe(4);
  expect(readFile).not.toHaveBeenCalled();
  expect(readFileSync.mock.calls.filter(([p]) => String(p).startsWith(projectDir()))).toEqual([]);
});

test('recentlyActive means written within the last 120 s', async () => {
  writeSession(uuid(1), { mtimeSec: T0 + 100 }); // 50 s before now
  writeSession(uuid(2), { mtimeSec: T0 + 30 }); // exactly 120 s
  writeSession(uuid(3), { mtimeSec: T0 }); // 150 s
  const r = await list({ deps: { now: () => (T0 + 150) * 1000 } });
  expect(r.sessions.map((s) => [s.sessionId, s.recentlyActive])).toEqual([[uuid(1), true], [uuid(2), false], [uuid(3), false]]);
});

test('strings are trimmed and capped at 300 chars without splitting a surrogate pair', async () => {
  writeSession(uuid(1), { prompt: `   ${'p'.repeat(1000)}   `, gitBranch: 'b'.repeat(400), mtimeSec: T0 + 1 });
  writeSession(uuid(2), { prompt: `${'a'.repeat(299)}😀tail` });
  const [long, emoji] = (await list()).sessions;
  expect(long.firstPrompt).toBe('p'.repeat(300));
  expect(long.gitBranch).toBe('b'.repeat(300));
  expect(emoji.firstPrompt).toBe('a'.repeat(299));
});

test('limit caps each kind and truncated says unread candidates remained', async () => {
  for (let i = 1; i <= 5; i += 1) writeSession(uuid(i), { mtimeSec: T0 + i });
  for (let i = 6; i <= 8; i += 1) writeSession(uuid(i), { entrypoint: 'sdk-cli', mtimeSec: T0 - i }); // older headless runs
  const two = await list({ limit: 2 });
  // A full interactive budget does not stop the walk: it reads on (3, 2, 1 dropped) until the headless one fills too.
  expect(ids(two)).toEqual([uuid(5), uuid(4), uuid(6), uuid(7)]);
  expect(two).toMatchObject({ scanned: 7, truncated: true });
  expect(await list({ limit: 5 })).toMatchObject({ scanned: 8, truncated: false });
});

test('at most 400 transcript heads are read per call', async () => {
  for (let i = 1; i <= 405; i += 1) writeTranscript(uuid(i), [user('elsewhere', { cwd: '/some/other/project' })], T0 + 1000 + i);
  writeSession(uuid(999), { mtimeSec: T0 }); // restorable, but older than the 400 newest
  expect(await list()).toEqual({ sessions: [], hiddenClaimed: 0, scanned: 400, truncated: true });
});

test('interactive and headless rows have separate budgets: 60 newer headless runs leave room for 3 interactive sessions', async () => {
  for (let i = 1; i <= 3; i += 1) writeSession(uuid(i), { mtimeSec: T0 + i });
  for (let i = 4; i <= 63; i += 1) writeSession(uuid(i), { entrypoint: 'sdk-cli', mtimeSec: T0 + i });
  const r = await list(); // default limit 50, per kind
  const newestHeadless = Array.from({ length: 50 }, (_, k) => uuid(63 - k));
  expect(r.sessions.filter((s) => !s.headless).map((s) => s.sessionId)).toEqual([uuid(3), uuid(2), uuid(1)]);
  expect(r.sessions.filter((s) => s.headless).map((s) => s.sessionId)).toEqual(newestHeadless);
  expect(ids(r)).toEqual([...newestHeadless, uuid(3), uuid(2), uuid(1)]); // still one array, newest first
  expect(r).toMatchObject({ hiddenClaimed: 0, scanned: 63, truncated: false });
});

test('an interactive session older than the 400-read window is not listed and truncated is true', async () => {
  for (let i = 1; i <= 399; i += 1) writeSession(uuid(1000 + i), { entrypoint: 'sdk-cli', mtimeSec: T0 + 1000 + i });
  writeSession(uuid(2), { prompt: 'read #400, the last one', mtimeSec: T0 + 2 });
  writeSession(uuid(1), { prompt: 'read #401, past the window', mtimeSec: T0 + 1 });
  const r = await list();
  expect(r.sessions.filter((s) => !s.headless).map((s) => s.sessionId)).toEqual([uuid(2)]);
  expect(r.sessions.filter((s) => s.headless)).toHaveLength(50);
  expect(r).toMatchObject({ scanned: 400, truncated: true });
});

test('checkRestorableSessionSync refuses a non-UUID id before touching the filesystem', () => {
  writeSession(uuid(1));
  // `../<this dir>/<uuid>` resolves to a real, restorable transcript — only the format check stops it.
  const sneaky = `../${encodeCwd(cwd)}/${uuid(1)}`;
  const statSync = vi.spyOn(fs, 'statSync');
  const openSync = vi.spyOn(fs, 'openSync');
  for (const bad of [sneaky, '../../../etc/passwd', `${uuid(1)}/../${uuid(1)}`, '..', '', `${uuid(1)}\u0000`, null, 42]) {
    expect(check(bad)).toMatchObject({ ok: false, code: 'invalid_id' });
  }
  expect(statSync).not.toHaveBeenCalled();
  expect(openSync).not.toHaveBeenCalled();
  const res = check(sneaky);
  expect(res.message).toContain(sneaky);
  expect(res.message).toContain(projectDir());
  expect(check(uuid(1))).toEqual({ ok: true, transcriptPath: transcript(uuid(1)) });
});

test('the claimed-id memo re-reads only an Epic file whose mtime:size changed', () => {
  writeArchive('epic-a', uuid(1), T0);
  writeArchive('epic-b', uuid(2), T0);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(2)]);

  const reads = vi.spyOn(atomicFs, 'readJsonOrSync');
  writeArchive('epic-a', uuid(3), T0); // same size and mtime: stays memoised (still reports uuid(1))
  writeArchive('epic-b', uuid(4), T0 + 5); // new mtime: re-read
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(4)]);
  expect(reads.mock.calls.map(([p]) => path.basename(p))).toEqual(['epic-b.json']);

  writeIndex({ e: { id: 'e', claudeSessionId: uuid(5) } }); // active-index.json appears: picked up, archives untouched
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(4), uuid(5)]);
  expect(reads).toHaveBeenCalledTimes(1);
});

test('claimedClaudeSessionIdsAsync equals the sync set, shares its memo and re-reads only a changed Epic file via fs.promises', async () => {
  writeIndex({ live: { id: 'live', claudeSessionId: uuid(9), status: 'active' } });
  writeArchive('epic-a', uuid(1), T0);
  writeArchive('epic-b', uuid(2), T0);
  fs.writeFileSync(path.join(promptDir(), 'epic-bad.json'), '{"session": '); // malformed: owns nothing
  const syncIds = claimedClaudeSessionIds(cwd, deps());
  __resetCacheForTests();
  const asyncIds = await claimedClaudeSessionIdsAsync(cwd, deps());
  expect(sorted(asyncIds)).toEqual([uuid(1), uuid(2), uuid(9)]);
  expect(sorted(asyncIds)).toEqual(sorted(syncIds));

  // Calls that touched an archived Epic file (active-index.json stays a sync readActiveIndex read).
  const onArchives = (spy) => spy.mock.calls.map(([p]) => String(p))
    .filter((p) => path.dirname(p) === promptDir() && path.basename(p) !== 'active-index.json')
    .map((p) => path.basename(p));
  const readFile = vi.spyOn(fs.promises, 'readFile');
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  const statSync = vi.spyOn(fs, 'statSync');
  writeArchive('epic-a', uuid(3), T0); // same size and mtime: stays memoised (still reports uuid(1))
  writeArchive('epic-b', uuid(4), T0 + 5); // new mtime: re-read
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([uuid(1), uuid(4), uuid(9)]);
  expect(onArchives(readFile)).toEqual(['epic-b.json']);
  expect(onArchives(readFileSync)).toEqual([]);
  expect(onArchives(statSync)).toEqual([]);

  // The sync reader starts from the memo the async one wrote: nothing changed since, so nothing is re-read.
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(4), uuid(9)]);
  expect(onArchives(readFileSync)).toEqual([]);
  expect(onArchives(readFile)).toEqual(['epic-b.json']);
});
