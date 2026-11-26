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
  listRecentRestorableSessions,
  checkRestorableSessionSync,
  showId,
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

/**
 * An archived Epic file, written as production writes it: tmp + rename
 * (atomicFs), so every rewrite is a new inode. The mtime is then forced, which
 * leaves a same-size rewrite with the same mtimeMs:size as the file it replaced.
 */
function writeArchive(epicId, claudeSessionId, mtimeSec = T0) {
  fs.mkdirSync(promptDir(), { recursive: true });
  const file = path.join(promptDir(), `${epicId}.json`);
  atomicFs.writeJsonAtomicSync(file, { session: { id: epicId, claudeSessionId, status: 'completed' }, events: {}, status: 'completed' });
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

/**
 * A fixture project dir with its own `.git`, so ops-root resolution
 * (classifyCwd's ancestor walk) stops at the fixture and never depends on
 * what the ~1,000 sibling test files put above it in the shared TMPDIR.
 */
function mkProject(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
}

/** Basenames of the archived Epic files (not active-index.json) a read spy saw. */
const archiveReads = (spy) => spy.mock.calls.map(([p]) => String(p))
  .filter((p) => path.dirname(p) === promptDir() && path.basename(p) !== 'active-index.json')
  .map((p) => path.basename(p));

/** An I/O error as fs raises it (not ENOENT, which reads as "gone, owns nothing"). */
const ioError = () => Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });

/**
 * Make the next `times` sync and async reads of `file` throw an I/O error
 * (`only` limits it to one side); every other read goes through. Returns the two spies.
 */
function failArchiveReads(file, times, only) {
  const left = { sync: only === 'async' ? 0 : times, async: only === 'sync' ? 0 : times };
  const realSync = fs.readFileSync;
  const realAsync = fs.promises.readFile;
  const readFileSync = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (String(p) === file && left.sync > 0) { left.sync -= 1; throw ioError(); }
    return realSync.call(fs, p, ...rest);
  });
  const readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (p, ...rest) => {
    if (String(p) === file && left.async > 0) { left.async -= 1; throw ioError(); }
    return realAsync.call(fs.promises, p, ...rest);
  });
  return { readFileSync, readFile };
}

beforeEach(() => {
  __resetCacheForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rs-'));
  home = path.join(root, 'home');
  cwd = path.join(root, 'project');
  mkProject(cwd);
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

function expectSneakyIdRefused() {
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
  // The id is echoed as the product renders it (showId caps long ids), so the
  // assertion holds however long TMPDIR makes the encoded cwd.
  expect(res.message).toContain(showId(sneaky));
  expect(res.message).toContain(projectDir());
  expect(check(uuid(1))).toEqual({ ok: true, transcriptPath: transcript(uuid(1)) });
  return sneaky;
}

test('checkRestorableSessionSync refuses a non-UUID id before touching the filesystem', () => {
  expectSneakyIdRefused();
  // A short id is echoed whole, inside the full message.
  expect(check('..').message).toBe(
    `Refused session id ".." for ${projectDir()}: not a Claude session UUID, so no path was built from it.`,
  );
});

test('the sneaky-id refusal holds under a TMPDIR over 120 characters long', () => {
  const savedTmp = process.env.TMPDIR;
  const savedRoot = root;
  const longTmp = path.join(root, 'tmpdir-'.padEnd(130 - root.length, 'x'));
  fs.mkdirSync(longTmp, { recursive: true });
  expect(longTmp.length).toBeGreaterThan(120);
  try {
    process.env.TMPDIR = longTmp;
    expect(os.tmpdir()).toBe(longTmp);
    __resetCacheForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rs-'));
    home = path.join(root, 'home');
    cwd = path.join(root, 'project');
    mkProject(cwd);
    const sneaky = expectSneakyIdRefused();
    expect(sneaky.length).toBeGreaterThan(80); // long enough that showId truncates it
    expect(check(sneaky).message).not.toContain(sneaky);
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    root = savedRoot; // afterEach removes savedRoot, which holds longTmp and the inner root
  }
});

test('the claimed-id memo re-reads only an Epic file that was rewritten', () => {
  writeArchive('epic-a', uuid(1), T0);
  writeArchive('epic-b', uuid(2), T0);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(2)]);

  const reads = vi.spyOn(fs, 'readFileSync');
  // epic-a untouched: served from the memo. epic-b rewritten: re-read.
  writeArchive('epic-b', uuid(4), T0 + 5);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(4)]);
  expect(archiveReads(reads)).toEqual(['epic-b.json']);

  writeIndex({ e: { id: 'e', claudeSessionId: uuid(5) } }); // active-index.json appears: picked up, archives untouched
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(4), uuid(5)]);
  expect(archiveReads(reads)).toEqual(['epic-b.json']);
});

test('a same-size rewrite that keeps its mtime is not served stale from the memo, sync or async', async () => {
  // Swapping one claudeSessionId for another never changes the size (UUIDs are
  // fixed-length); with the mtime kept, mtimeMs:size alone cannot see the rewrite.
  const file = writeArchive('epic-a', uuid(1), T0);
  const before = fs.statSync(file);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1)]);

  writeArchive('epic-a', uuid(2), T0);
  const after = fs.statSync(file);
  expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(2)]);

  writeArchive('epic-a', uuid(3), T0);
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([uuid(3)]);
});

test('a failed read of an unchanged archived Epic file is not memoised: the next call re-reads it, sync and async', async () => {
  const file = writeArchive('epic-a', uuid(1), T0);

  // A transient I/O failure (EMFILE, EIO) on the read and on its one retry.
  failArchiveReads(file, 2);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([]);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1)]);

  __resetCacheForTests();
  vi.restoreAllMocks();
  failArchiveReads(file, 2);
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([]);
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([uuid(1)]);
  // ...and the sync reader, sharing that memo, does not inherit the failed read either.
  __resetCacheForTests();
  vi.restoreAllMocks();
  failArchiveReads(file, 2, 'async');
  await claimedClaudeSessionIdsAsync(cwd, deps());
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1)]);
});

test('an archived Epic file that reads fine but is empty, invalid JSON or not an object is memoised as owning nothing, sync and async', async () => {
  writeArchive('epic-a', uuid(1), T0);
  fs.writeFileSync(path.join(promptDir(), 'epic-empty.json'), '  \n');
  fs.writeFileSync(path.join(promptDir(), 'epic-bad.json'), '{"session": ');
  fs.writeFileSync(path.join(promptDir(), 'epic-num.json'), '42');
  const bad = ['epic-bad.json', 'epic-empty.json', 'epic-num.json'];

  const readFileSync = vi.spyOn(fs, 'readFileSync');
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1)]);
  expect(archiveReads(readFileSync).sort()).toEqual(['epic-a.json', ...bad]);
  readFileSync.mockClear();
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1)]);
  expect(archiveReads(readFileSync)).toEqual([]);

  __resetCacheForTests();
  const readFile = vi.spyOn(fs.promises, 'readFile');
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([uuid(1)]);
  expect(archiveReads(readFile).sort()).toEqual(['epic-a.json', ...bad]);
  readFile.mockClear();
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([uuid(1)]);
  expect(archiveReads(readFile)).toEqual([]);
});

test('an I/O read failure of an archived Epic file is retried once in the same call, sync and async', async () => {
  const file = writeArchive('epic-a', uuid(1), T0);
  writeSession(uuid(1));

  const sync = failArchiveReads(file, 1);
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1)]);
  expect(archiveReads(sync.readFileSync)).toEqual(['epic-a.json', 'epic-a.json']);
  expect(check(uuid(1))).toMatchObject({ ok: false, code: 'claimed' });

  __resetCacheForTests();
  vi.restoreAllMocks();
  const both = failArchiveReads(file, 1);
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([uuid(1)]);
  expect(archiveReads(both.readFile)).toEqual(['epic-a.json', 'epic-a.json']);
  __resetCacheForTests();
  expect(await list()).toMatchObject({ sessions: [], hiddenClaimed: 1 });
});

test('when the retry fails too, the record is not memoised and listRestorableSessions lists no rows for that call', async () => {
  const file = writeArchive('epic-a', uuid(1), T0);
  writeSession(uuid(1), { mtimeSec: T0 + 2 });
  writeSession(uuid(2), { mtimeSec: T0 + 1 }); // unclaimed: listed once the scan is complete
  const { readFile } = failArchiveReads(file, 2);

  expect(await list()).toEqual({ sessions: [], hiddenClaimed: 0, scanned: 0, truncated: false });
  expect(archiveReads(readFile)).toEqual(['epic-a.json', 'epic-a.json']);
  // Not memoised: the next call reads the file again, claims uuid(1) and lists uuid(2).
  const r = await list();
  expect(archiveReads(readFile)).toEqual(['epic-a.json', 'epic-a.json', 'epic-a.json']);
  expect(ids(r)).toEqual([uuid(2)]);
  expect(r.hiddenClaimed).toBe(1);
});

test('when the retry fails too, checkRestorableSessionSync refuses with a retryable reason', () => {
  const file = writeArchive('epic-a', uuid(1), T0);
  writeSession(uuid(1));
  writeSession(uuid(2));
  failArchiveReads(file, 4);

  // Even an id no readable Epic claims is refused: the unread file could own it.
  for (const sid of [uuid(1), uuid(2)]) {
    const res = check(sid);
    expect(res).toMatchObject({ ok: false, code: 'claim_check_unreadable' });
    expect(res.message).toContain('could not read an Epic file');
    expect(res.message).toContain('Try again');
  }
  // The I/O failure has cleared: the same check now answers on the real claim.
  expect(check(uuid(1))).toMatchObject({ ok: false, code: 'claimed' });
  expect(check(uuid(2))).toEqual({ ok: true, transcriptPath: transcript(uuid(2)) });
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
  const onArchives = archiveReads;
  const readFile = vi.spyOn(fs.promises, 'readFile');
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  const statSync = vi.spyOn(fs, 'statSync');
  // epic-a untouched: served from the memo. epic-b rewritten: re-read. epic-bad
  // read fine but is malformed, which is memoised as owning nothing, so it is not re-read.
  writeArchive('epic-b', uuid(4), T0 + 5);
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([uuid(1), uuid(4), uuid(9)]);
  expect(onArchives(readFile).sort()).toEqual(['epic-b.json']);
  expect(onArchives(readFileSync)).toEqual([]);
  expect(onArchives(statSync)).toEqual([]);

  // The sync reader starts from the memo the async one wrote: no archived Epic file is re-read.
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([uuid(1), uuid(4), uuid(9)]);
  expect(onArchives(readFileSync)).toEqual([]);
  expect(onArchives(readFile).sort()).toEqual(['epic-b.json']);
});

// ── listRecentRestorableSessions: machine-wide, bounded merge ──────────────

/** Run `fn` with the fixture helpers pointed at project `p`. */
function inProject(p, fn) {
  const saved = cwd;
  cwd = p;
  try { mkProject(p); return fn(); } finally { cwd = saved; }
}

/** Four projects, each with a transcript dir whose mtime orders them A (newest) … D. */
function fourProjects() {
  const projects = ['a', 'b', 'c', 'd'].map((n) => path.join(root, `proj-${n}`));
  const [a, b, c, d] = projects;
  inProject(a, () => {
    writeSession(uuid(11), { prompt: 'a newest', mtimeSec: T0 + 400 });
    writeSession(uuid(12), { entrypoint: 'sdk-cli', mtimeSec: T0 + 500 }); // headless: dropped
    writeSession(uuid(13), { prompt: 'a claimed', mtimeSec: T0 + 450 });
    writeIndex({ e1: { id: 'e1', claudeSessionId: uuid(13), status: 'active' } });
  });
  inProject(b, () => {
    writeSession(uuid(21), { prompt: 'b one', mtimeSec: T0 + 300 });
    writeSession(uuid(22), { prompt: 'b two', mtimeSec: T0 + 100 });
  });
  inProject(c, () => writeSession(uuid(31), { prompt: 'c one', mtimeSec: T0 + 200 }));
  inProject(d, () => writeSession(uuid(41), { prompt: 'd one', mtimeSec: T0 + 50 }));
  // Transcript-folder mtimes: the activity order the lister must pick projects by.
  projects.forEach((p, i) => inProject(p, () => fs.utimesSync(projectDir(), T0 + 1000 - i * 10, T0 + 1000 - i * 10)));
  return projects;
}

function recentDeps(projects, extra = {}) {
  const reads = [];
  const deps = {
    homeDir: home,
    // Deliberately not in activity order: the lister must sort by folder mtime.
    allProjectCwds: () => [projects[2], projects[0], projects[3], projects[1]],
    listRestorableSessions: (opts) => { reads.push(opts.cwd); return listRestorableSessions(opts); },
    ...extra,
  };
  return { deps, reads };
}

test('listRecentRestorableSessions merges interactive rows across projects newest first, with cwd on every row', async () => {
  const projects = fourProjects();
  const { deps: d, reads } = recentDeps(projects);
  const r = await listRecentRestorableSessions({ deps: d });
  expect(r.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
    [uuid(11), projects[0]],
    [uuid(21), projects[1]],
    [uuid(31), projects[2]],
    [uuid(22), projects[1]],
    [uuid(41), projects[3]],
  ]);
  // Headless uuid(12) dropped; Epic-claimed uuid(13) hidden.
  expect(r.sessions.every((s) => s.headless === false && typeof s.cwd === 'string')).toBe(true);
  expect(r.sessions[0]).toMatchObject({ firstPrompt: 'a newest', mtimeMs: (T0 + 400) * 1000 });
  expect(r.projectsRead).toBe(4);
  expect(r.truncated).toBe(false);
  expect(sorted(reads)).toEqual(sorted(projects));
});

test('listRecentRestorableSessions reads only maxProjects projects, newest folder first, and cuts to limit', async () => {
  const projects = fourProjects();
  const { deps: d, reads } = recentDeps(projects);
  const r = await listRecentRestorableSessions({ maxProjects: 2, deps: d });
  expect(reads).toHaveLength(2);
  expect(sorted(reads)).toEqual(sorted([projects[0], projects[1]]));
  expect(r.projectsRead).toBe(2);
  expect(r.truncated).toBe(true);
  expect(ids(r)).toEqual([uuid(11), uuid(21), uuid(22)]);

  const cut = await listRecentRestorableSessions({ limit: 2, deps: recentDeps(projects).deps });
  expect(ids(cut)).toEqual([uuid(11), uuid(21)]);
  expect(cut.truncated).toBe(true);
});

test('listRecentRestorableSessions passes perProject as the per-project limit and runs at most 4 reads at once', async () => {
  const projects = Array.from({ length: 8 }, (_, i) => path.join(root, `many-${i}`));
  projects.forEach((p, i) => inProject(p, () => writeSession(uuid(100 + i), { mtimeSec: T0 + i })));
  let inFlight = 0;
  let peak = 0;
  const limits = [];
  const d = {
    homeDir: home,
    allProjectCwds: () => projects,
    listRestorableSessions: async (opts) => {
      limits.push(opts.limit);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
      return listRestorableSessions(opts);
    },
  };
  const r = await listRecentRestorableSessions({ perProject: 3, deps: d });
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1);
  expect(limits.every((l) => l === 3)).toBe(true);
  expect(r.projectsRead).toBe(8);
  expect(ids(r)).toEqual(projects.map((_, i) => uuid(107 - i)));
});

test('listRecentRestorableSessions skips a project whose read fails and never throws', async () => {
  const projects = fourProjects();
  const { deps: d } = recentDeps(projects, {
    listRestorableSessions: async (opts) => {
      if (opts.cwd === projects[1]) throw new Error('EACCES');
      return listRestorableSessions(opts);
    },
  });
  const r = await listRecentRestorableSessions({ deps: d });
  expect(ids(r)).toEqual([uuid(11), uuid(31), uuid(41)]);
  const broken = await listRecentRestorableSessions({ deps: { homeDir: home, allProjectCwds: () => { throw new Error('boom'); } } });
  expect(broken).toEqual({ sessions: [], projectsRead: 0, truncated: false });
});

for (const order of ['complete-first', 'incomplete-first']) {
  test(`two overlapping list calls of one cwd each act on their own claim scan (${order})`, async () => {
    const file = writeArchive('epic-a', uuid(1), T0);
    writeSession(uuid(1), { mtimeSec: T0 + 2 });
    writeSession(uuid(2), { mtimeSec: T0 + 1 }); // unclaimed
    const realAsync = fs.promises.readFile;
    const content = fs.readFileSync(file, 'utf8');
    /** @type {{ resolve: (v: string) => void, reject: (e: Error) => void }[]} */
    const pending = [];
    // Each archive read announces itself on `nthRead[n]`, so the test waits
    // for the exact read it orders on — no timer or event-loop yield count
    // (both raced the real readdir/stat thread-pool work in full-suite runs).
    /** @type {{ promise: Promise<void>, resolve: () => void }[]} */
    const nthRead = [1, 2, 3].map(() => {
      /** @type {() => void} */
      let resolve = () => {};
      const promise = new Promise((r) => { resolve = () => r(undefined); });
      return { promise, resolve };
    });
    vi.spyOn(fs.promises, 'readFile').mockImplementation((p, ...rest) => {
      if (String(p) !== file) return realAsync.call(fs.promises, p, ...rest);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        nthRead[pending.length - 1]?.resolve();
      });
    });
    const readStarted = (n) => nthRead[n - 1].promise;

    // Start B only once A's archive read is pending: both scans walk real
    // readdir/stat first, so starting them together let B's read land first
    // and swap the roles of pending[0] and pending[1].
    const a = list(); // scan A: its archive read fails, then its retry fails
    await readStarted(1);
    const b = list(); // scan B: its archive read succeeds
    await readStarted(2);
    expect(pending).toHaveLength(2);
    const [a1, b1] = pending;
    a1.reject(ioError());
    await readStarted(3);
    expect(pending).toHaveLength(3);
    const a2 = pending[2];
    if (order === 'complete-first') { b1.resolve(content); a2.reject(ioError()); }
    else { a2.reject(ioError()); b1.resolve(content); }

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ sessions: [], hiddenClaimed: 0, scanned: 0, truncated: false });
    expect(ids(rb)).toEqual([uuid(2)]);
    expect(rb.hiddenClaimed).toBe(1);
  });
}

/** ENOENT as fs raises it for a file removed since readdir listed it. */
const goneError = () => Object.assign(new Error('ENOENT: no such file or directory, open'), { code: 'ENOENT' });

test('an archived Epic file gone between readdir and read (ENOENT) claims nothing, is not incomplete and is not retried, sync', () => {
  const file = writeArchive('epic-a', uuid(1), T0);
  writeSession(uuid(1));
  const realSync = fs.readFileSync;
  const readFileSync = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (String(p) === file) throw goneError();
    return realSync.call(fs, p, ...rest);
  });
  expect(check(uuid(1))).toEqual({ ok: true, transcriptPath: transcript(uuid(1)) });
  expect(archiveReads(readFileSync)).toEqual(['epic-a.json']);
  __resetCacheForTests();
  readFileSync.mockClear();
  expect(sorted(claimedClaudeSessionIds(cwd, deps()))).toEqual([]);
  expect(archiveReads(readFileSync)).toEqual(['epic-a.json']);
});

test('an archived Epic file gone between readdir and read (ENOENT) claims nothing, is not incomplete and is not retried, async', async () => {
  const file = writeArchive('epic-a', uuid(1), T0);
  writeSession(uuid(1));
  const realAsync = fs.promises.readFile;
  const readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (p, ...rest) => {
    if (String(p) === file) throw goneError();
    return realAsync.call(fs.promises, p, ...rest);
  });
  const r = await list();
  expect(ids(r)).toEqual([uuid(1)]);
  expect(r.hiddenClaimed).toBe(0);
  expect(archiveReads(readFile)).toEqual(['epic-a.json']);
  __resetCacheForTests();
  readFile.mockClear();
  expect(sorted(await claimedClaudeSessionIdsAsync(cwd, deps()))).toEqual([]);
  expect(archiveReads(readFile)).toEqual(['epic-a.json']);
});
