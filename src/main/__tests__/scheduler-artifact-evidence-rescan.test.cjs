/**
 * scheduler-artifact-evidence-rescan.test.cjs — rescanArtifactEvidence hands
 * the stale needs_review rescan the artifact evidence spawnJob persisted on the
 * job row, but only when it was captured for the SAME run being re-verified.
 *
 * The reverifyNeedsReview tests drive the real pass over a persisted
 * needs_review row: run-bound artifactEvidence must reach verifyRun and heal a
 * declared artifact that lives only in the (already-removed) job worktree,
 * while evidence from another run must not.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs (runsDir,
 * audit log and project discovery all resolve under $HOME).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-artifact-evidence-rescan.test.cjs
 */

'use strict';

import { test, expect, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const originalHome = process.env.HOME;
const originalAutofix = process.env.SM_AUTOFIX_DISABLE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-evidence-rescan-test-'));
process.env.HOME = tmpHome;
process.env.SM_AUTOFIX_DISABLE = '1';

const { registerActiveProject, writeProjectQueue, writeRunLog } = require('./_helpers/schedulerHarness.cjs');
const { rescanArtifactEvidence, reverifyNeedsReview } = require('../scheduler.cjs');
const { resolvePrdWriteDir } = require('../lib/prd/prdLocations.cjs');

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalAutofix === undefined) delete process.env.SM_AUTOFIX_DISABLE;
  else process.env.SM_AUTOFIX_DISABLE = originalAutofix;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const evidence = {
  runId: 'run-a',
  ok: true,
  verified: [{ path: 'out/report.txt', size: 7, mtime: '2026-11-24T00:00:00.000Z' }],
  paths: ['out/report.txt'],
  capturedAt: '2026-11-24T00:00:01.000Z',
};

test('same runId returns the persisted evidence', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: evidence }, 'run-a')).toBe(evidence);
});

test('a different runId returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: evidence }, 'run-b')).toBeNull();
});

test('a missing field returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's' }, 'run-a')).toBeNull();
});

test('null evidence returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: null }, 'run-a')).toBeNull();
});

test('a non-object value returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: 'run-a' }, 'run-a')).toBeNull();
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: 42 }, 'run-a')).toBeNull();
});

test('never throws on a missing or malformed job', () => {
  expect(rescanArtifactEvidence(null, 'run-a')).toBeNull();
  expect(rescanArtifactEvidence(undefined, 'run-a')).toBeNull();
  const hostile = {};
  Object.defineProperty(hostile, 'artifactEvidence', { get() { throw new Error('boom'); } });
  expect(rescanArtifactEvidence(hostile, 'run-a')).toBeNull();
});

// --- reverifyNeedsReview over a persisted row ---

const ARTIFACT_PATHS = ['out/report.txt'];

function initBackdatedRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args, env) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'out/\nsession-manager-operations/\n', 'utf8');
  git(['add', '-A']);
  // Backdated so no commit falls inside the row's run window.
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  git(['commit', '-q', '-m', 'initial'], { GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past });
}

async function reverifyCase(name, evidenceRunId) {
  const projectCwd = path.join(tmpHome, `proj-${name}`);
  initBackdatedRepo(projectCwd);
  registerActiveProject(projectCwd, `proj-${name}-slug`);
  const slug = `4379-artifact-rescan-${name}`;
  const prdDir = resolvePrdWriteDir(projectCwd);
  fs.mkdirSync(prdDir, { recursive: true });
  fs.writeFileSync(path.join(prdDir, `${slug}.md`),
    `---\ntitle: t\ncwd: ${projectCwd}\ndeliverable: artifact\nartifactPaths: [${ARTIFACT_PATHS.join(', ')}]\n---\n\n# Goal\n\nship it\n`);
  // The artifact lived only in the removed job worktree — absent from the checkout.
  expect(fs.existsSync(path.join(projectCwd, ARTIFACT_PATHS[0]))).toBe(false);

  const runId = `run-${name}`;
  writeRunLog(runId, slug, [JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done\nSCHEDULER_VERDICT: PASS' })]);
  const startedAt = new Date(Date.now() - 120 * 1000).toISOString();
  const finishedAt = new Date(Date.now() - 60 * 1000).toISOString();
  const queuePath = writeProjectQueue(projectCwd, [{
    slug,
    status: 'needs_review',
    cwd: projectCwd,
    runId,
    startedAt,
    finishedAt,
    exitCode: 0,
    verifierVerdict: 'verify_unavailable',
    artifactEvidence: {
      runId: evidenceRunId === 'same' ? runId : evidenceRunId,
      ok: true,
      verified: [{ path: ARTIFACT_PATHS[0], size: 7, mtime: new Date(Date.now() - 90 * 1000).toISOString() }],
      paths: [...ARTIFACT_PATHS],
      capturedAt: finishedAt,
    },
  }]);

  await reverifyNeedsReview();
  return JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
}

test('reverifyNeedsReview heals a worktree-only artifact from run-bound artifactEvidence', async () => {
  const row = await reverifyCase('same-run', 'same');
  expect(row.status).toBe('completed');
}, 60_000);

test('reverifyNeedsReview does not heal on artifactEvidence from a different run', async () => {
  const row = await reverifyCase('other-run', 'some-other-run');
  expect(row.status).toBe('needs_review');
}, 60_000);
