/**
 * scheduler-artifact-finish-prompt.test.cjs — an artifact-only PRD
 * (frontmatter deliverable: artifact + non-empty artifactPaths) commits
 * nothing by design, so its finish protocol must say PASS on a green gate
 * with no commit. Self job 826-project-home-build printed a false FAIL for
 * the missing commit and parked in needs_review.
 *
 * Drives the REAL executeJob spawn path via SM_CLAUDE_BIN pointing at a stub
 * that captures the prompt, so the assertion checks exactly what `claude -p`
 * would receive — and that the flag is read from the PRD FILE's frontmatter,
 * not from the (hand-built) queue row.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-artifact-finish-prompt.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

const ARTIFACT_BULLET = 'This job is artifact-only: its PRD declares deliverable: artifact.';
const ARTIFACT_COMMIT = 'This job is artifact-only: its output is git-excluded, so there is nothing to stage.';

let tmpHome;
let originalHome;
let originalClaudeBin;
let executeJob;

beforeAll(() => {
  originalHome = process.env.HOME;
  originalClaudeBin = process.env.SM_CLAUDE_BIN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifact-finish-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../scheduler.cjs'));
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

function writeClaudeStub(capturePath) {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const prompt = readPrompt();
    fs.writeFileSync(${JSON.stringify(capturePath)}, prompt, 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

function setupProject(prefix) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-project-`));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', `${prefix}-run-`));
  return { projectCwd, runDir };
}

function writeLegacyPrd(projectCwd, slug, text) {
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), text, 'utf8');
}

async function capturePromptFor(prefix, frontmatterExtra) {
  const { projectCwd, runDir } = setupProject(prefix);
  try {
    const slug = `3109-${prefix}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const text = `---\ntitle: Build the page\n${frontmatterExtra}---\nSave the page to out/page.html.\n`;
    writeLegacyPrd(projectCwd, slug, text);
    const capturePath = path.join(runDir, 'captured-prompt.txt');
    process.env.SM_CLAUDE_BIN = writeClaudeStub(capturePath);
    // Row deliberately carries no deliverable/artifactPaths: the flag must
    // come from the PRD file's own frontmatter.
    const result = await executeJob({ slug, cwd: projectCwd }, runDir, projectCwd, () => Promise.resolve());
    expect(result.exitCode).toBe(0);
    return fs.readFileSync(capturePath, 'utf8');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

test('artifact-only PRD (deliverable: artifact + artifactPaths) gets the artifact-only finish bullets', async () => {
  const prompt = await capturePromptFor('sm-artifact-hit', 'deliverable: artifact\nartifactPaths: [out/page.html]\n');
  expect(prompt).toContain('SCHEDULER FINISH PROTOCOL');
  expect(prompt).toContain(ARTIFACT_BULLET);
  expect(prompt).toContain(ARTIFACT_COMMIT);
  expect(prompt.indexOf('Print PASS only when')).toBeLessThan(prompt.indexOf(ARTIFACT_BULLET));
});

test('the same PRD without deliverable/artifactPaths gets the plain finish protocol', async () => {
  const prompt = await capturePromptFor('sm-artifact-miss', '');
  expect(prompt).toContain('SCHEDULER FINISH PROTOCOL');
  expect(prompt).not.toContain(ARTIFACT_BULLET);
  expect(prompt).not.toContain(ARTIFACT_COMMIT);
});
