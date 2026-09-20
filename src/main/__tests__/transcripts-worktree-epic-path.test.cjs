/**
 * transcripts-worktree-epic-path.test.cjs — transcriptPath()/subscribe() resolve
 * an Epic's transcript through epicTranscriptPath (worktree encoding), while a
 * non-Epic tab keeps the plain project encoding. Includes a parity check of the
 * renderer's transcriptExists() (EpicTerminalPane's resume-vs-create decision)
 * against the REAL transcriptPath instead of a constant mock.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/transcripts-worktree-epic-path.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { transcriptExists } from '../../renderer/lib/transcriptExists';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let tr;
let resolver;
let encodeCwd;
let proj;
const SID = 'b8a5d6f4-0092-4db0-a687-009241f2a8b2';
const WT = '/tmp/sm-wt-test-epic-worktree-dir';

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-transcripts-wt-home-'));
  process.env.HOME = tmpHome;
  tr = require('../transcripts.cjs');
  resolver = require('../lib/epicTranscriptPath.cjs');
  ({ encodeCwd } = require('../lib/encodeCwd.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  resolver.__resetCacheForTests();
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-transcripts-wt-proj-'));
});

afterEach(() => {
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const projectsDir = () => path.join(tmpHome, '.claude', 'projects');
const plain = (cwd, id = SID) => path.join(projectsDir(), encodeCwd(cwd), `${id}.jsonl`);

function writeIndex(sessionId = SID) {
  const dir = path.join(proj, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const s = { id: 'epic-1', cwd: proj, claudeSessionId: sessionId, status: 'active', worktree: { dir: WT, branch: 'sm-epic/epic-1', baseCwd: proj, status: 'active' } };
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions: { 'epic-1': s }, events: {} }));
}

function writeTranscript(p, body = '{"type":"user"}\n') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

test('worktree-present: transcript only under the worktree encoding resolves there', () => {
  writeIndex();
  fs.mkdirSync(WT, { recursive: true });
  try {
    writeTranscript(plain(WT));
    expect(tr.transcriptPath(proj, SID)).toBe(plain(WT));
  } finally {
    fs.rmSync(WT, { recursive: true, force: true });
  }
});

test('worktree-swept: worktree dir gone from disk, transcript still found', () => {
  writeIndex();
  expect(fs.existsSync(WT)).toBe(false);
  writeTranscript(plain(WT));
  expect(tr.transcriptPath(proj, SID)).toBe(plain(WT));
});

test('non-Epic tab resolves to exactly the pre-change path, even when an Epic exists', () => {
  writeIndex();
  writeTranscript(plain(WT));
  const rawTab = 'raw-tab-id-123';
  expect(tr.transcriptPath(proj, rawTab)).toBe(path.join(os.homedir(), '.claude', 'projects', encodeCwd(proj), `${rawTab}.jsonl`));
  // no index at all
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-transcripts-wt-other-'));
  try {
    expect(tr.transcriptPath(other, SID)).toBe(plain(other));
    expect(path.isAbsolute(tr.transcriptPath(other, SID))).toBe(true);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('zero-byte transcript counts as existing and does not break usageFor', async () => {
  writeIndex();
  writeTranscript(plain(WT), '');
  expect(tr.transcriptPath(proj, SID)).toBe(plain(WT));
  const out = await tr.usageFor(proj, [SID]);
  expect(out).toHaveProperty(SID);
});

test('subscribe does NOT mkdir when a transcript exists elsewhere (worktree encoding)', async () => {
  writeIndex();
  writeTranscript(plain(WT));
  const before = fs.readdirSync(projectsDir()).sort();
  const res = await tr.subscribe({ tabId: 'tab-wt', cwd: proj, sessionUuid: SID });
  try {
    expect(res.ok).toBe(true);
    expect(res.path).toBe(plain(WT));
    expect(fs.readdirSync(projectsDir()).sort()).toEqual(before);
    expect(fs.existsSync(path.dirname(plain(proj)))).toBe(false);
  } finally {
    tr.closeTab('tab-wt');
  }
});

test('subscribe of a brand-new Epic watches the spawn-cwd path and creates its dir', async () => {
  writeIndex();
  const res = await tr.subscribe({ tabId: 'tab-new', cwd: proj, sessionUuid: SID });
  try {
    expect(res.ok).toBe(true);
    // no transcript anywhere → resolver's first candidate (spawn cwd), whose dir the CLI will write
    expect(fs.existsSync(path.dirname(res.path))).toBe(true);
    expect(fs.existsSync(res.path)).toBe(false);
  } finally {
    tr.closeTab('tab-new');
  }
});

test('parity: renderer transcriptExists (Terminal resume decision) sees a worktree-only transcript', async () => {
  writeIndex();
  vi.stubGlobal('window', {
    api: {
      transcripts: { pathFor: async (c, s) => tr.transcriptPath(c, s) },
      config: { exists: async (p) => fs.existsSync(p) },
    },
  });
  expect(await transcriptExists(proj, SID)).toBe(false);
  writeTranscript(plain(WT));
  expect(await transcriptExists(proj, SID)).toBe(true);
  // zero-byte still "exists"
  writeTranscript(plain(WT), '');
  expect(await transcriptExists(proj, SID)).toBe(true);
  // raw tab never resolves into the Epic's worktree encoding
  expect(await transcriptExists(proj, 'raw-tab')).toBe(false);
});
