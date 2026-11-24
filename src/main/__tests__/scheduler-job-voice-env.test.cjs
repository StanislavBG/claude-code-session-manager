/**
 * scheduler-job-voice-env.test.cjs — a PRD's `voiceId` frontmatter (a
 * library voice, e.g. a Video tool job's) is parsed onto the job row and
 * executeJob hands the spawned `claude -p` SM_VOICE_ID. A job without a
 * valid voiceId gets none — not even one inherited from the parent env.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-job-voice-env.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let executeJob;
let parsePrd;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-job-voice-env-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../scheduler.cjs'));
  ({ parsePrd } = require('../scheduler/prdParser.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  delete process.env.SM_VOICE_ID;
});

// Stub `claude`: dumps SM_VOICE_ID (null when absent) and exits 0.
function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    const has = Object.prototype.hasOwnProperty.call(process.env, 'SM_VOICE_ID');
    fs.writeFileSync(path.join(process.cwd(), 'env.marker'), JSON.stringify({
      has,
      value: has ? process.env.SM_VOICE_ID : null,
    }), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

// Writes the PRD with the given frontmatter lines, parses it the way
// reconcile does, and launches the job built from the parsed voiceId.
async function runJob(frontmatterLines, extraRow = {}) {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-job-voice-main-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-job-voice-run-'));
  try {
    const slug = `4053-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    const prdPath = path.join(prdsDir, `${slug}.md`);
    fs.writeFileSync(prdPath, `---\ntitle: Voice env\n${frontmatterLines.join('\n')}${frontmatterLines.length ? '\n' : ''}---\nVerify the voice env.\n`, 'utf8');
    const p = await parsePrd(prdPath);
    process.env.SM_CLAUDE_BIN = writeClaudeStub();
    const row = { slug, cwd: mainCwd, estimateMinutes: 10, voiceId: p.voiceId ?? null, ...extraRow };
    const result = await executeJob(row, runDir, mainCwd, () => Promise.resolve());
    expect(result.exitCode).toBe(0);
    return { parsed: p, marker: JSON.parse(fs.readFileSync(path.join(mainCwd, 'env.marker'), 'utf8')) };
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

test('a PRD written with voiceId yields SM_VOICE_ID in the launched job env', async () => {
  const { parsed, marker } = await runJob(['voiceId: narrator_1']);
  expect(parsed.voiceId).toBe('narrator_1');
  expect(marker).toEqual({ has: true, value: 'narrator_1' });
});

test('a job without voiceId gets no SM_VOICE_ID, even one inherited from the parent env', async () => {
  process.env.SM_VOICE_ID = 'leaked';
  const { parsed, marker } = await runJob([]);
  expect(parsed.voiceId).toBeNull();
  expect(marker.has).toBe(false);
});

test('a row carrying a malformed voiceId gets no SM_VOICE_ID', async () => {
  const { marker } = await runJob([], { voiceId: 'Bad Voice;rm' });
  expect(marker.has).toBe(false);
});
