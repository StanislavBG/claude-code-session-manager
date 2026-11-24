// harvestJobArtifacts: a finished PRD job's declared artifactPaths and its
// SM_ARTIFACTS_DIR staging folder are copied into the project's Artifacts
// store (artifacts/<epic-id>/, producer prdSlug) before worktree teardown.
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EPIC = 'epic-abc123';
const RUN = '2026-11-23T10-00-00-000Z';
let tmp;
let projectRoot;
let worktreeDir;
let prevWtRoot;
let scheduler;
let artifactStore;

function write(root, rel, text = 'content\n') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

function storeDir() {
  return path.join(projectRoot, 'session-manager-operations', 'artifacts', EPIC);
}

function ledger() {
  return JSON.parse(fs.readFileSync(path.join(storeDir(), 'index.json'), 'utf8')).entries;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-job-harvest-'));
  projectRoot = path.join(tmp, 'project');
  worktreeDir = path.join(tmp, 'worktree');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });
  prevWtRoot = process.env.SM_WORKTREE_ROOT;
  process.env.SM_WORKTREE_ROOT = path.join(tmp, 'wt-root');
  scheduler = require('../scheduler.cjs');
  artifactStore = require('../lib/epic/artifactStore.cjs');
});

afterEach(() => {
  if (prevWtRoot === undefined) delete process.env.SM_WORKTREE_ROOT;
  else process.env.SM_WORKTREE_ROOT = prevWtRoot;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('declared files + staging folder land in artifacts/<epic-id>/ with prdSlug in the ledger', { timeout: 30_000 }, async () => {
  const job = {
    slug: '4038-artifact-job-harvest',
    epicId: EPIC,
    runId: RUN,
    artifactPaths: [
      'out/report.md',
      'session-manager-operations/plan-records/epic-abc123/plan.md',
      'out/missing.png',
      'out/',
      '../escape.txt',
    ],
  };
  write(worktreeDir, 'out/report.md', '# report\n');
  write(worktreeDir, 'session-manager-operations/plan-records/epic-abc123/plan.md', 'plan\n');
  write(tmp, 'escape.txt', 'nope\n');
  const staging = artifactStore.stagingDirFor({ runId: scheduler.jobArtifactRunId(job, RUN) });
  expect(staging.startsWith(process.env.SM_WORKTREE_ROOT)).toBe(true);
  write(staging, 'clip.mp4', 'video-bytes');

  await scheduler.harvestJobArtifacts(job, worktreeDir, projectRoot);

  const names = fs.readdirSync(storeDir()).sort();
  expect(names).toEqual(['clip.mp4', 'index.json', 'report.md']);
  expect(fs.readFileSync(path.join(storeDir(), 'report.md'), 'utf8')).toBe('# report\n');
  const entries = ledger();
  expect(entries.map((e) => e.name).sort()).toEqual(['clip.mp4', 'report.md']);
  for (const e of entries) {
    expect(e.producer.prdSlug).toBe('4038-artifact-job-harvest');
    expect(e.producer.epicId).toBe(EPIC);
  }
  // Plan records stay with the plan-record harvest; staged sources are consumed.
  expect(entries.some((e) => e.name === 'plan.md')).toBe(false);
  expect(fs.existsSync(path.join(staging, 'clip.mp4'))).toBe(false);
  // The worktree copy of a declared artifact is left intact.
  expect(fs.existsSync(path.join(worktreeDir, 'out/report.md'))).toBe(true);
});

test('a missing worktree is a logged no-op', { timeout: 30_000 }, async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const job = { slug: '4038-x', epicId: EPIC, runId: RUN, artifactPaths: ['out/report.md'] };
  await expect(
    scheduler.harvestJobArtifacts(job, path.join(tmp, 'gone'), projectRoot),
  ).resolves.toBeUndefined();
  expect(fs.existsSync(path.join(projectRoot, 'session-manager-operations', 'artifacts'))).toBe(false);
  expect(warn.mock.calls.some((c) => String(c[0]).includes('worktree missing'))).toBe(true);
});

test('jobArtifactRunId is per job and always a safe staging id', () => {
  const a = scheduler.jobArtifactRunId({ slug: 'a' }, RUN);
  const b = scheduler.jobArtifactRunId({ slug: 'b' }, RUN);
  expect(a).not.toBe(b);
  const long = scheduler.jobArtifactRunId({ slug: 'x'.repeat(300) }, RUN);
  expect(artifactStore.RUN_ID_RE.test(long)).toBe(true);
});

test('a harvest posts ONE artifact-ready notice with every published entry, and none when nothing landed', { timeout: 30_000 }, async () => {
  const events = require('../promptSessionEvents.cjs');
  const append = vi.spyOn(events, 'appendResponseEventWithReason').mockResolvedValue({ ok: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const job = { slug: '4401-notice', epicId: EPIC, runId: RUN, artifactPaths: ['out/report.md'] };
  write(worktreeDir, 'out/report.md', '# report\n');
  const staging = artifactStore.stagingDirFor({ runId: scheduler.jobArtifactRunId(job, RUN) });
  write(staging, 'clip.mp4', 'video-bytes');

  await scheduler.harvestJobArtifacts(job, worktreeDir, projectRoot);

  expect(append).toHaveBeenCalledTimes(1);
  const [cwd, epicId, text, meta] = append.mock.calls[0];
  expect(cwd).toBe(projectRoot);
  expect(epicId).toBe(EPIC);
  expect(text).toBe('2 artifacts ready');
  expect(meta.notice).toBe('artifact-ready');
  expect(meta.artifacts.map((a) => a.title).sort()).toEqual(['clip.mp4', 'report.md']);

  append.mockClear();
  const empty = { slug: '4401-empty', epicId: EPIC, runId: RUN, artifactPaths: ['out/missing.png'] };
  await scheduler.harvestJobArtifacts(empty, worktreeDir, projectRoot);
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

test('real store + real git: job artifactPaths (publishArtifact) and staging (ingestDir) leave nothing visible to git', { timeout: 30_000 }, async () => {
  const events = require('../promptSessionEvents.cjs');
  vi.spyOn(events, 'appendResponseEventWithReason').mockResolvedValue({ ok: true });
  const root = gitProject(fs.realpathSync(tmp), 'git-project-');
  const wt = fs.realpathSync(worktreeDir);
  const job = { slug: '4438-git-invisible', epicId: EPIC, runId: RUN, artifactPaths: ['out/report.md'] };
  write(wt, 'out/report.md', '# report\n');
  const staging = artifactStore.stagingDirFor({ runId: scheduler.jobArtifactRunId(job, RUN) });
  write(staging, 'clip.mp4', 'video-bytes');

  await scheduler.harvestJobArtifacts(job, wt, root);

  const dir = path.join(root, 'session-manager-operations', 'artifacts', EPIC);
  assertGitInvisible(root, path.join(dir, 'report.md')); // artifactPaths → publishArtifact
  assertGitInvisible(root, path.join(dir, 'clip.mp4')); // staging → ingestDir
  expect(fs.existsSync(path.join(staging, 'clip.mp4'))).toBe(false);
});
