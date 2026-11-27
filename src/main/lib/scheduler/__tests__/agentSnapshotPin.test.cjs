/**
 * agentSnapshotPin.test.cjs — ma-agent-snapshot-pin-dispatch: a dispatch
 * builds its persona argv from an AgentSnapshot and stamps agentSnapshotId on
 * the job and the run meta; a resume of that job re-runs the PINNED snapshot
 * (body, model, tools) even after the live persona file was edited; a pinned
 * snapshot that is missing or tampered is refused agent_snapshot_missing and
 * never spawned.
 *
 * Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/agentSnapshotPin.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let executeJob;
let agentSnapshot;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-agent-snapshot-pin-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../../../scheduler.cjs'));
  agentSnapshot = require('../../claude/agentSnapshot.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'argv.marker'), JSON.stringify(process.argv.slice(2)), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

function writePersona(cwd, name, { model, tools, body }) {
  const dir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), ['---', `name: ${name}`, `model: ${model}`, `tools: ${tools}`, '---', body].join('\n'));
}

function setupProject() {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pin-main-'));
  const slug = `3775-pin-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  process.env.SM_CLAUDE_BIN = writeClaudeStub();
  return { mainCwd, slug };
}

async function dispatch(job, mainCwd, resumeTarget = null) {
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-pin-run-'));
  const marker = path.join(mainCwd, 'argv.marker');
  fs.rmSync(marker, { force: true });
  const result = await executeJob(job, runDir, mainCwd, () => Promise.resolve(), undefined, resumeTarget);
  const argv = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${job.slug}.meta.json`), 'utf8'));
  const logFile = path.join(runDir, `${job.slug}.log`);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  fs.rmSync(runDir, { recursive: true, force: true });
  return { result, argv, meta, log };
}

const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('a resume re-runs the pinned snapshot (body, model, tools) after the persona file was edited', async () => {
  const { mainCwd, slug } = setupProject();
  try {
    writePersona(mainCwd, 'pin-persona', { model: 'opus', tools: 'Read, WebFetch', body: 'ORIGINAL persona body.' });
    const job = { slug, cwd: mainCwd, agentType: 'pin-persona' };

    const first = await dispatch(job, mainCwd);
    expect(first.result.exitCode).toBe(0);
    expect(job.agentSnapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.meta.agentSnapshotId).toBe(job.agentSnapshotId);
    expect(argAfter(first.argv, '--append-system-prompt')).toBe('ORIGINAL persona body.');
    expect(argAfter(first.argv, '--model')).toBe('opus');
    expect(argAfter(first.argv, '--agents')).toContain('WebFetch');
    const pinned = await agentSnapshot.readAgentSnapshot(mainCwd, job.agentSnapshotId);
    expect(pinned.body).toBe('ORIGINAL persona body.');

    // Edit the live persona between the first dispatch and the resume.
    writePersona(mainCwd, 'pin-persona', { model: 'haiku', tools: 'Read, WebSearch', body: 'EDITED persona body.' });

    const resumed = await dispatch({ ...job }, mainCwd, { sessionId: 'resume-sid-3775', dirtyPaths: [] });
    expect(resumed.result.exitCode).toBe(0);
    expect(resumed.argv).toContain('--resume');
    expect(argAfter(resumed.argv, '--append-system-prompt')).toBe('ORIGINAL persona body.');
    expect(argAfter(resumed.argv, '--model')).toBe('opus');
    const agentsJson = argAfter(resumed.argv, '--agents');
    expect(agentsJson).toContain('WebFetch');
    expect(agentsJson).not.toContain('WebSearch');
    expect(resumed.meta.agentSnapshotId).toBe(job.agentSnapshotId);

    // An unstamped dispatch picks up the edit and mints a new snapshot.
    const fresh = { slug, cwd: mainCwd, agentType: 'pin-persona' };
    const third = await dispatch(fresh, mainCwd);
    expect(argAfter(third.argv, '--append-system-prompt')).toBe('EDITED persona body.');
    expect(argAfter(third.argv, '--model')).toBe('haiku');
    expect(fresh.agentSnapshotId).not.toBe(job.agentSnapshotId);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
});

test('a missing pinned snapshot is refused agent_snapshot_missing and never spawned', async () => {
  const { mainCwd, slug } = setupProject();
  try {
    writePersona(mainCwd, 'pin-persona', { model: 'opus', tools: 'Read', body: 'body' });
    const { result, argv, meta } = await dispatch({ slug, cwd: mainCwd, agentType: 'pin-persona', agentSnapshotId: 'a'.repeat(64) }, mainCwd);
    expect(argv).toBeNull();
    expect(result.exitCode).toBe(-1);
    expect(result.personaRefusal.code).toBe('agent_snapshot_missing');
    expect(meta.personaRefusal.code).toBe('agent_snapshot_missing');
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
});

test('a tampered pinned snapshot is refused agent_snapshot_missing and never spawned', async () => {
  const { mainCwd, slug } = setupProject();
  try {
    writePersona(mainCwd, 'pin-persona', { model: 'opus', tools: 'Read', body: 'body' });
    const job = { slug, cwd: mainCwd, agentType: 'pin-persona' };
    await dispatch(job, mainCwd);
    const file = path.join(mainCwd, 'session-manager-operations', 'agents', 'snapshots', `${job.agentSnapshotId}.json`);
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...snap, body: 'tampered' }));
    const { result, argv } = await dispatch({ ...job }, mainCwd, { sessionId: 'resume-sid-3775b', dirtyPaths: [] });
    expect(argv).toBeNull();
    expect(result.personaRefusal.code).toBe('agent_snapshot_missing');
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
});

test('a pinned snapshot whose persona differs from the job agentType is re-pinned audibly', async () => {
  const { mainCwd, slug } = setupProject();
  try {
    writePersona(mainCwd, 'pin-persona', { model: 'opus', tools: 'Read', body: 'FIRST persona body.' });
    writePersona(mainCwd, 'other-persona', { model: 'haiku', tools: 'Read, WebSearch', body: 'OTHER persona body.' });
    const job = { slug, cwd: mainCwd, agentType: 'pin-persona' };
    const first = await dispatch(job, mainCwd);
    const oldId = job.agentSnapshotId;
    expect(first.meta.agentSnapshotRepinned).toBeUndefined();

    const same = { ...job };
    const unchanged = await dispatch(same, mainCwd);
    expect(same.agentSnapshotId).toBe(oldId);
    expect(unchanged.meta.agentSnapshotRepinned).toBeUndefined();

    const changed = { ...job, agentType: 'other-persona' };
    const second = await dispatch(changed, mainCwd);
    expect(argAfter(second.argv, '--append-system-prompt')).toBe('OTHER persona body.');
    expect(argAfter(second.argv, '--model')).toBe('haiku');
    expect(argAfter(second.argv, '--agents')).toContain('WebSearch');
    expect(changed.agentSnapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(changed.agentSnapshotId).not.toBe(oldId);
    expect(second.meta.agentSnapshotId).toBe(changed.agentSnapshotId);
    expect(second.log).toContain(`(re-pinned from ${oldId.slice(0, 8)}: agentType changed)`);
    expect(second.meta.agentSnapshotRepinned).toEqual({ from: oldId, to: changed.agentSnapshotId, reason: 'agentType_changed' });
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
});
