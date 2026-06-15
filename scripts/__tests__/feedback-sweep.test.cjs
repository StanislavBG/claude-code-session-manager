'use strict';

// Run: timeout 120 node --test scripts/__tests__/feedback-sweep.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasOpenFeedback, emitFeedbackPRD, sweep } = require('../lib/watchdogHelpers.cjs');

const FAKE_SKILL = [
  '---',
  'name: process-feedback',
  'description: Process feedback.',
  '---',
  '',
  '# process-feedback',
  '',
  '## Steps',
  '',
  '### 0. Quick-exit — bail if nothing to do',
  '',
  'If no open items exist, exit immediately.',
  '',
  '### 1. Read the intake',
  '',
  'Read feedback/README.md, then every open file.',
  '',
].join('\n');

const FAKE_STANDARDS = [
  '# Engineering standards',
  '',
  '> Single source of truth for developer guidance.',
  '',
  '## Execution discipline (headless runs)',
  '',
  'Bound every command. Verify before done.',
  '',
].join('\n');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-sweep-test-'));
}

function makeQueue(base, jobs = []) {
  const queuePath = path.join(base, 'queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ version: 1, jobs, paused: null }, null, 2));
  return queuePath;
}

function makeSkillFiles(base) {
  const skillPath = path.join(base, 'SKILL.md');
  const standardsPath = path.join(base, 'standards.md');
  fs.writeFileSync(skillPath, FAKE_SKILL);
  fs.writeFileSync(standardsPath, FAKE_STANDARDS);
  return { skillPath, standardsPath };
}

// ── (a) open feedback/2026-01-01-foo.md → hasOpenFeedback true + PRD written ─

test('(a) open feedback file → hasOpenFeedback true and PRD emitted with correct content', () => {
  const base = makeTmpDir();
  try {
    const projectDir = path.join(base, 'myproject');
    const feedbackDir = path.join(projectDir, 'feedback');
    fs.mkdirSync(feedbackDir, { recursive: true });
    fs.writeFileSync(path.join(feedbackDir, '2026-01-01-foo.md'), '# Feedback\n\nSome request.\n');

    assert.equal(hasOpenFeedback(projectDir), true, 'hasOpenFeedback should be true');

    const prdsDir = path.join(base, 'prds');
    fs.mkdirSync(prdsDir);
    const queuePath = makeQueue(base);
    const { skillPath, standardsPath } = makeSkillFiles(base);

    const result = emitFeedbackPRD(projectDir, { prdsDir, queuePath, skillPath, standardsPath });
    assert.equal(result.emitted, true, 'PRD should be emitted');

    const prdFiles = fs.readdirSync(prdsDir);
    assert.equal(prdFiles.length, 1, 'exactly one PRD file should be written');

    const prdContent = fs.readFileSync(path.join(prdsDir, prdFiles[0]), 'utf8');

    // frontmatter must contain cwd
    assert.ok(prdContent.includes(`cwd: ${projectDir}`), `PRD must contain cwd: ${projectDir}`);

    // body must contain inlined process-feedback procedure
    assert.ok(prdContent.includes('process-feedback'), 'PRD body must contain process-feedback');
    assert.ok(prdContent.includes('Quick-exit'), 'PRD body must contain quick-exit step');

    // body must have ## Engineering standards section
    assert.ok(prdContent.includes('## Engineering standards'), 'PRD body must have ## Engineering standards section');
    assert.ok(prdContent.includes('Bound every command'), 'PRD body must contain standards content');

    // slug format: NN-feedback-myproject
    assert.ok(/^\d+-feedback-myproject\.md$/.test(prdFiles[0]), `PRD filename should match slug pattern, got: ${prdFiles[0]}`);

    // file must be clean UTF-8 (no NUL bytes)
    assert.ok(!prdContent.includes('\0'), 'PRD body must be clean UTF-8');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (b) only feedback/processed/old.md → hasOpenFeedback false ───────────────

test('(b) only processed/ subdir → hasOpenFeedback false', () => {
  const base = makeTmpDir();
  try {
    const projectDir = path.join(base, 'myproject');
    const processedDir = path.join(projectDir, 'feedback', 'processed');
    fs.mkdirSync(processedDir, { recursive: true });
    fs.writeFileSync(path.join(processedDir, 'old.md'), '# Old feedback\n');

    assert.equal(hasOpenFeedback(projectDir), false,
      'hasOpenFeedback must be false when only processed/ exists');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (b2) no feedback dir at all → hasOpenFeedback false ──────────────────────

test('(b2) no feedback dir → hasOpenFeedback false', () => {
  const base = makeTmpDir();
  try {
    const projectDir = path.join(base, 'emptyproject');
    fs.mkdirSync(projectDir);

    assert.equal(hasOpenFeedback(projectDir), false, 'hasOpenFeedback must be false with no feedback dir');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (b3) external-feedback/ with open file → hasOpenFeedback true ────────────

test('(b3) external-feedback/ with open .md → hasOpenFeedback true', () => {
  const base = makeTmpDir();
  try {
    const projectDir = path.join(base, 'myproject');
    const efDir = path.join(projectDir, 'external-feedback');
    fs.mkdirSync(efDir, { recursive: true });
    fs.writeFileSync(path.join(efDir, '2026-01-01-request.md'), '# Request\n');

    assert.equal(hasOpenFeedback(projectDir), true,
      'hasOpenFeedback must be true for external-feedback/ open file');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (c) pending feedback job in queue → no duplicate PRD emitted ─────────────

test('(c) pending feedback job already queued → no duplicate PRD', () => {
  const base = makeTmpDir();
  try {
    const projectDir = path.join(base, 'myproject');
    const feedbackDir = path.join(projectDir, 'feedback');
    fs.mkdirSync(feedbackDir, { recursive: true });
    fs.writeFileSync(path.join(feedbackDir, '2026-01-01-foo.md'), '# Feedback\n');

    // Queue already has a pending feedback job for this project
    const queuePath = makeQueue(base, [
      { slug: '99-feedback-myproject', status: 'pending', title: 'Process feedback for myproject' },
    ]);

    const prdsDir = path.join(base, 'prds');
    fs.mkdirSync(prdsDir);
    const { skillPath, standardsPath } = makeSkillFiles(base);

    const result = emitFeedbackPRD(projectDir, { prdsDir, queuePath, skillPath, standardsPath });
    assert.equal(result.emitted, false, 'should not emit duplicate PRD');
    assert.equal(result.reason, 'duplicate', 'reason should be duplicate');

    const prdFiles = fs.readdirSync(prdsDir);
    assert.equal(prdFiles.length, 0, 'no PRD file should be written when duplicate detected');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (c2) running feedback job in queue → no duplicate PRD ────────────────────

test('(c2) running feedback job in queue → no duplicate PRD', () => {
  const base = makeTmpDir();
  try {
    const projectDir = path.join(base, 'myproject');
    const feedbackDir = path.join(projectDir, 'feedback');
    fs.mkdirSync(feedbackDir, { recursive: true });
    fs.writeFileSync(path.join(feedbackDir, '2026-01-01-foo.md'), '# Feedback\n');

    const queuePath = makeQueue(base, [
      { slug: '50-feedback-myproject', status: 'running', title: 'Process feedback for myproject' },
    ]);

    const prdsDir = path.join(base, 'prds');
    fs.mkdirSync(prdsDir);
    const { skillPath, standardsPath } = makeSkillFiles(base);

    const result = emitFeedbackPRD(projectDir, { prdsDir, queuePath, skillPath, standardsPath });
    assert.equal(result.emitted, false, 'should not emit duplicate PRD for running job');
    assert.equal(result.reason, 'duplicate');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── NN selection: next after highest existing ─────────────────────────────────

test('NN selection picks next after highest existing in prdsDir', () => {
  const base = makeTmpDir();
  try {
    const projectDir = path.join(base, 'aproject');
    const feedbackDir = path.join(projectDir, 'feedback');
    fs.mkdirSync(feedbackDir, { recursive: true });
    fs.writeFileSync(path.join(feedbackDir, '2026-01-01-x.md'), '# X\n');

    const prdsDir = path.join(base, 'prds');
    fs.mkdirSync(prdsDir);
    // Pre-populate with some existing PRDs
    fs.writeFileSync(path.join(prdsDir, '05-some-work.md'), '---\ntitle: t\n---\n');
    fs.writeFileSync(path.join(prdsDir, '07-other-work.md'), '---\ntitle: t\n---\n');

    const queuePath = makeQueue(base);
    const { skillPath, standardsPath } = makeSkillFiles(base);

    const result = emitFeedbackPRD(projectDir, { prdsDir, queuePath, skillPath, standardsPath });
    assert.equal(result.emitted, true);
    // NN should be 08 (max is 07)
    assert.ok(result.slug.startsWith('08-'), `slug should start with 08-, got: ${result.slug}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── sweep() returns { scanned, emitted, skipped } ────────────────────────────

test('sweep() returns correct summary counts', () => {
  const base = makeTmpDir();
  try {
    // Project 1: has open feedback → should emit
    const proj1 = path.join(base, 'proj1');
    fs.mkdirSync(path.join(proj1, 'feedback'), { recursive: true });
    fs.writeFileSync(path.join(proj1, 'feedback', '2026-01-01-item.md'), '# Item\n');

    // Project 2: no feedback dir → should not emit
    const proj2 = path.join(base, 'proj2');
    fs.mkdirSync(proj2);

    // Fake prompts.jsonl with both projects as recently active
    const logDir = path.join(base, 'knowledge-log');
    fs.mkdirSync(logDir);
    const logPath = path.join(logDir, 'prompts.jsonl');
    const recentTs = Date.now() - 10 * 60 * 1000; // 10 min ago
    fs.writeFileSync(logPath, [
      JSON.stringify({ ts: recentTs, cwd: proj1 }),
      JSON.stringify({ ts: recentTs, cwd: proj2 }),
    ].join('\n') + '\n');

    const prdsDir = path.join(base, 'prds');
    fs.mkdirSync(prdsDir);
    const queuePath = makeQueue(base);
    const { skillPath, standardsPath } = makeSkillFiles(base);

    const result = sweep({
      logPath,
      projectsDir: path.join(base, 'projects'), // won't be used (logPath has data)
      prdsDir,
      queuePath,
      skillPath,
      standardsPath,
    });

    assert.equal(result.scanned, 2, 'scanned should count all active cwds');
    assert.equal(result.emitted, 1, 'emitted should count projects with open feedback');
    assert.equal(result.skipped, 0, 'skipped should count de-dup hits');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
