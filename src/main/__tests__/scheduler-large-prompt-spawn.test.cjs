/**
 * A prompt far over Linux's 128 KB per-argument limit must reach the child on
 * stdin, never argv (2026-10-26 spawn E2BIG incident).
 *
 * Run: npx vitest run src/main/__tests__/scheduler-large-prompt-spawn.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let sched;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-large-prompt-'));
  process.env.HOME = tmpHome;
  sched = require('../scheduler.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

test('executeJob sends a 300 KB PRD + 5,000 carried paths on stdin; argv stays small', async () => {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-large-prompt-main-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-large-prompt-run-'));
  const capture = path.join(runDir, 'capture.json');
  try {
    const slug = `large-prompt-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    const sentinel = 'UNIQUE-SENTINEL-LINE-END-OF-PRD-9f3a';
    const body = `${'x'.repeat(99).concat('\n').repeat(3000)}${sentinel}\n`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(300 * 1000 - 1000);
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), body, 'utf8');

    process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ prompt: readPrompt(), argv: process.argv.slice(2) }), 'utf8');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
      process.exit(0);
    ` });

    const carriedPaths = Array.from({ length: 5000 }, (_, i) => `src/some/deep/dir-${i % 50}/file-${i}.txt`);
    const result = await sched.executeJob(
      { slug, cwd: mainCwd }, runDir, mainCwd, () => Promise.resolve(),
      undefined, null, { carriedPaths });
    expect(result.exitCode).toBe(0);

    const { prompt, argv } = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(prompt).toContain(sentinel);
    expect(prompt).toContain('--- FOREIGN WORKING-TREE STATE (not your work) ---');
    const start = prompt.indexOf('--- FOREIGN WORKING-TREE STATE (not your work) ---');
    const endMarker = '--- END FOREIGN WORKING-TREE STATE ---';
    const end = prompt.indexOf(endMarker, start) + endMarker.length;
    expect(Buffer.byteLength(prompt.slice(start, end))).toBeLessThanOrEqual(sched.FOREIGN_WIP_SECTION_MAX_BYTES);
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('--model');
    for (const a of argv) expect(Buffer.byteLength(a)).toBeLessThan(131072);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 60000);
