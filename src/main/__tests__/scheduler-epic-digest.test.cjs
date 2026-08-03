/**
 * scheduler-epic-digest.test.cjs — PRD 958: prepend the Epic context digest
 * (PRD 950's epicContextDigest.cjs) to a job's prompt when job.epicId
 * resolves to a known Epic (same resolution resolveOriginSessionId already
 * performs). Additive only: the PRD's own body + FINISH_PROTOCOL must remain
 * byte-for-byte unchanged, and a digest build failure must never block
 * dispatch.
 *
 * Drives the REAL spawn path via SM_CLAUDE_BIN pointing at a stub process
 * that captures the '-p' prompt argv to a file, so the assertions inspect
 * exactly what would have been sent to `claude -p`.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-epic-digest.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let originalClaudeBin;
let executeJob;
let FINISH_PROTOCOL;
let buildContextDigest;

beforeAll(() => {
  originalHome = process.env.HOME;
  originalClaudeBin = process.env.SM_CLAUDE_BIN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-digest-'));
  process.env.HOME = tmpHome;

  ({ executeJob, FINISH_PROTOCOL } = require('../scheduler.cjs'));
  ({ buildContextDigest } = require('../lib/epicContextDigest.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalClaudeBin === undefined) delete process.env.SM_CLAUDE_BIN;
  else process.env.SM_CLAUDE_BIN = originalClaudeBin;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

// Stub `claude` binary: captures the '-p' prompt argv to `capturePath`, then
// emits one stream-json result line and exits 0.
function writeClaudeStub(capturePath) {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const idx = process.argv.indexOf('-p');
    const prompt = idx >= 0 ? process.argv[idx + 1] : '';
    fs.writeFileSync(${JSON.stringify(capturePath)}, prompt, 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

function setupProject(prefix) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-project-`));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', `${prefix}-run-`));
  return { projectCwd, runDir };
}

function writeLegacyPrd(projectCwd, slug, bodyText) {
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), bodyText, 'utf8');
  return path.join(prdsDir, `${slug}.md`);
}

function writeActiveIndex(projectCwd, sessions) {
  const idxPath = path.join(projectCwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  fs.mkdirSync(path.dirname(idxPath), { recursive: true });
  fs.writeFileSync(idxPath, JSON.stringify({ sessions, events: {} }, null, 2), 'utf8');
}

test('prepends the Epic context digest when job.epicId resolves to a known Epic', async () => {
  const { projectCwd, runDir } = setupProject('sm-epic-digest-hit');
  try {
    const epicId = 'epic-hit-1';
    writeActiveIndex(projectCwd, {
      [epicId]: { claudeSessionId: 'sess-abc-123', goalText: 'Ship the digest feature.' },
    });

    const slug = `958-test-hit-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const bodyText = 'Do the thing described in this PRD body.';
    writeLegacyPrd(projectCwd, slug, bodyText);

    const capturePath = path.join(runDir, 'captured-prompt.txt');
    process.env.SM_CLAUDE_BIN = writeClaudeStub(capturePath);

    const job = { slug, cwd: projectCwd, epicId };
    const result = await executeJob(job, runDir, projectCwd, () => Promise.resolve());

    expect(result.exitCode).toBe(0);
    const capturedPrompt = fs.readFileSync(capturePath, 'utf8');

    const digestText = await buildContextDigest({ cwd: projectCwd, epicId });
    expect(digestText.length).toBeGreaterThan(0);
    // Section order: PRD body -> fenced Epic-context digest -> finish
    // protocol -> task restatement (PRD 992). The finish protocol must NOT
    // be buried ahead of the digest — that was the defect this PRD fixes.
    expect(capturedPrompt.startsWith(bodyText)).toBe(true);
    const bodyIndex = capturedPrompt.indexOf(bodyText);
    const digestIndex = capturedPrompt.indexOf(digestText);
    const fenceEndIndex = capturedPrompt.indexOf('--- END EPIC CONTEXT ---');
    const finishProtocolIndex = capturedPrompt.indexOf('SCHEDULER FINISH PROTOCOL');
    const restatementIndex = capturedPrompt.indexOf('Your task is the PRD at the top of this prompt. Implement it now.');
    expect(digestIndex).toBeGreaterThan(bodyIndex);
    expect(capturedPrompt).toContain('BEGIN EPIC CONTEXT (background only');
    expect(fenceEndIndex).toBeGreaterThan(digestIndex);
    expect(finishProtocolIndex).toBeGreaterThan(fenceEndIndex);
    expect(restatementIndex).toBeGreaterThan(finishProtocolIndex);
    expect(capturedPrompt.trim().endsWith('Your task is the PRD at the top of this prompt. Implement it now.')).toBe(true);

    // The PRD source on disk must never be rewritten with the digest merged in.
    const onDiskPrd = fs.readFileSync(path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds', `${slug}.md`), 'utf8');
    expect(onDiskPrd).toBe(bodyText);

    const metaPath = path.join(runDir, `${slug}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.contextDigestApplied).toBe(true);
    expect(meta.originSessionId).toBe('sess-abc-123');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('is a silent no-op when job.epicId does not resolve to a known Epic', async () => {
  const { projectCwd, runDir } = setupProject('sm-epic-digest-miss');
  try {
    const slug = `958-test-miss-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const bodyText = 'Do the thing described in this PRD body, unaccompanied.';
    writeLegacyPrd(projectCwd, slug, bodyText);

    const capturePath = path.join(runDir, 'captured-prompt.txt');
    process.env.SM_CLAUDE_BIN = writeClaudeStub(capturePath);

    // epicId is absent entirely — no active-index.json even exists for this project.
    const job = { slug, cwd: projectCwd };
    const result = await executeJob(job, runDir, projectCwd, () => Promise.resolve());

    expect(result.exitCode).toBe(0);
    const capturedPrompt = fs.readFileSync(capturePath, 'utf8');
    expect(capturedPrompt).toBe(bodyText + FINISH_PROTOCOL);

    const metaPath = path.join(runDir, `${slug}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.contextDigestApplied).toBe(false);
    expect(meta.originSessionId).toBe(null);
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('a digest build failure is caught and never blocks dispatch', async () => {
  const { projectCwd, runDir } = setupProject('sm-epic-digest-fail');
  try {
    const epicId = 'epic-fail-1';
    writeActiveIndex(projectCwd, {
      [epicId]: { claudeSessionId: 'sess-def-456', goalText: 'This Epic exists and resolves fine.' },
    });

    const slug = `958-test-fail-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const bodyText = 'Do the thing even if the digest build blows up.';
    writeLegacyPrd(projectCwd, slug, bodyText);

    const capturePath = path.join(runDir, 'captured-prompt.txt');
    process.env.SM_CLAUDE_BIN = writeClaudeStub(capturePath);

    // Stub epicContextDigest.cjs's export to reject, then force scheduler.cjs
    // to re-require it so it picks up the stub (mirrors exchanges.test.cjs's
    // summarize.cjs stubbing pattern) — only scheduler.cjs's own cache entry
    // is cleared, not its whole dependency tree.
    const digestPath = require.resolve('../lib/epicContextDigest.cjs');
    const realDigestModule = require.cache[digestPath];
    const { composeExecutorPrompt: realComposeExecutorPrompt } = require('../lib/epicContextDigest.cjs');
    require.cache[digestPath] = {
      id: digestPath,
      filename: digestPath,
      loaded: true,
      exports: {
        buildContextDigest: async () => {
          throw new Error('boom: digest build exploded');
        },
        composeExecutorPrompt: realComposeExecutorPrompt,
      },
    };
    const schedulerPath = require.resolve('../scheduler.cjs');
    delete require.cache[schedulerPath];
    const freshScheduler = require('../scheduler.cjs');

    try {
      const job = { slug, cwd: projectCwd, epicId };
      const result = await freshScheduler.executeJob(job, runDir, projectCwd, () => Promise.resolve());

      expect(result.exitCode).toBe(0);
      const capturedPrompt = fs.readFileSync(capturePath, 'utf8');
      // Digest failed to build — prompt falls back to the un-prefixed PRD body.
      expect(capturedPrompt).toBe(bodyText + FINISH_PROTOCOL);

      const metaPath = path.join(runDir, `${slug}.meta.json`);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.contextDigestApplied).toBe(false);
      expect(meta.originSessionId).toBe('sess-def-456');
    } finally {
      // Restore real modules for any later test in this file/process.
      if (realDigestModule) require.cache[digestPath] = realDigestModule;
      else delete require.cache[digestPath];
      delete require.cache[schedulerPath];
      ({ executeJob, FINISH_PROTOCOL } = require('../scheduler.cjs'));
    }
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
