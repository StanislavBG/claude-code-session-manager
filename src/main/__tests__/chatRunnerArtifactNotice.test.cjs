// The chat turn-end ingest (chatRunner ingestChatArtifacts) posts ONE 'artifact-ready'
// notice in the Epic's chat when files landed, and none when nothing was published.
// Run: timeout 120 npx vitest run src/main/__tests__/chatRunnerArtifactNotice.test.cjs
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EPIC = 'epic-chat-notice';
let tmp;
let prevWtRoot;
let chatRunner;
let artifactStore;
let events;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-artifact-notice-'));
  prevWtRoot = process.env.SM_WORKTREE_ROOT;
  process.env.SM_WORKTREE_ROOT = path.join(tmp, 'wt-root');
  chatRunner = require('../chatRunner.cjs');
  artifactStore = require('../lib/epic/artifactStore.cjs');
  events = require('../promptSessionEvents.cjs');
});

afterEach(() => {
  if (prevWtRoot === undefined) delete process.env.SM_WORKTREE_ROOT;
  else process.env.SM_WORKTREE_ROOT = prevWtRoot;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a turn that published files posts one notice with every published entry', async () => {
  const cwd = path.join(tmp, 'project');
  const published = [
    { srcPath: '/s/a.png', storedPath: path.join(cwd, 'session-manager-operations/artifacts', EPIC, 'a.png'), entry: { name: 'a.png', kind: 'image', size: 3 } },
    { srcPath: '/s/b.md', storedPath: path.join(cwd, 'session-manager-operations/artifacts', EPIC, 'b.md'), entry: { name: 'b.md', kind: 'doc', size: 4 } },
  ];
  const ingest = vi.spyOn(artifactStore, 'ingestDir').mockResolvedValue({ published, skipped: [] });
  const append = vi.spyOn(events, 'appendResponseEventWithReason').mockResolvedValue({ ok: true });

  const res = await chatRunner.__ingestChatArtifacts({ cwd, sessionId: EPIC, srcDir: path.join(tmp, 'staging') });

  expect(res.published).toBe(published);
  expect(ingest).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledTimes(1);
  const [aCwd, aEpic, text, meta] = append.mock.calls[0];
  expect(aCwd).toBe(cwd);
  expect(aEpic).toBe(EPIC);
  expect(text).toBe('2 artifacts ready');
  expect(meta.notice).toBe('artifact-ready');
  expect(meta.artifacts.map((a) => a.path)).toEqual([
    `session-manager-operations/artifacts/${EPIC}/a.png`,
    `session-manager-operations/artifacts/${EPIC}/b.md`,
  ]);
});

test('a turn that published nothing posts no notice', async () => {
  const cwd = path.join(tmp, 'project');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(artifactStore, 'ingestDir').mockResolvedValue({ published: [], skipped: [{ path: 'x.bin', reason: 'too_big' }] });
  const append = vi.spyOn(events, 'appendResponseEventWithReason').mockResolvedValue({ ok: true });

  await chatRunner.__ingestChatArtifacts({ cwd, sessionId: EPIC, srcDir: path.join(tmp, 'staging') });

  expect(append).not.toHaveBeenCalled();
});

// Real git: the stored file is ignored and nothing under artifacts/ is visible.
function assertGitInvisible(root, storedPath) {
  const { execFileSync } = require('node:child_process');
  expect(fs.existsSync(storedPath)).toBe(true);
  expect(() => execFileSync('git', ['check-ignore', '-q', storedPath], { cwd: root })).not.toThrow();
  expect(execFileSync('git', ['status', '--porcelain', '-uall', '--', 'session-manager-operations/artifacts'], { cwd: root, encoding: 'utf8' })).toBe('');
}
function gitProject(parent, name) {
  const { execFileSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, name)));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('real store + real git: a chat-turn ingest leaves nothing visible to git', async () => {
  vi.restoreAllMocks();
  vi.spyOn(events, 'appendResponseEventWithReason').mockResolvedValue({ ok: true });
  const cwd = gitProject(fs.realpathSync(tmp), 'git-project-');
  const srcDir = path.join(fs.realpathSync(tmp), 'staging');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'shot.png'), 'png-bytes');

  const res = await chatRunner.__ingestChatArtifacts({ cwd, sessionId: EPIC, srcDir });

  expect(res.skipped).toEqual([]);
  expect(res.published).toHaveLength(1);
  const stored = res.published[0].storedPath;
  expect(stored).toBe(path.join(cwd, 'session-manager-operations', 'artifacts', EPIC, 'shot.png'));
  assertGitInvisible(cwd, stored);
});
