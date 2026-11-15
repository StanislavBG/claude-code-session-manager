/**
 * scheduler-packs-spawn.test.cjs — PRD 3154: a PRD job launches with its
 * Epic's selected context packs — one --plugin-dir per pack, and the packs'
 * laws appended after the persona body in the single --append-system-prompt.
 * Fresh and resume spawns alike; no Epic / no packs / lookup error = today's argv.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-packs-spawn.test.cjs
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
let buildClaudeSpawnArgs;
let packSpawnArgs;
let agentModelResolve;
let realCompose;

const LAWS = '# Context packs for this session\n\n## Test pack\n\nAlways test.';

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-packs-spawn-'));
  process.env.HOME = tmpHome;
  ({ executeJob, buildClaudeSpawnArgs } = require('../scheduler.cjs'));
  packSpawnArgs = require('../lib/packs/packSpawnArgs.cjs');
  agentModelResolve = require('../lib/claude/agentModelResolve.cjs');
  realCompose = packSpawnArgs.composePackSpawnArgs;
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'dev-lead.md'), '---\nname: dev-lead\nmodel: opus\n---\nYou are dev-lead.');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  packSpawnArgs.composePackSpawnArgs = realCompose;
});

/** Test catalog in place of the shipped (platform-gated) packs. */
function stubCatalog(calls) {
  packSpawnArgs.composePackSpawnArgs = (opts) => {
    calls.push(opts);
    return realCompose({
      ...opts,
      catalog: [{ id: 'test-pack', label: 'Test', dir: '/abs/packs/test-pack', laws: 'Always test.' }],
    });
  };
}

function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'argv.marker'), JSON.stringify(process.argv.slice(2)), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

async function runJob({ agentType = 'dev-lead', epic, jobEpic = 'epic-1', resumeTarget = null, rawIndex }) {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-packs-main-'));
  const psDir = path.join(mainCwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(psDir, { recursive: true });
  if (rawIndex !== undefined) fs.writeFileSync(path.join(psDir, 'active-index.json'), rawIndex);
  else if (epic) fs.writeFileSync(path.join(psDir, 'active-index.json'), JSON.stringify({ sessions: { [epic.id]: epic } }));
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-packs-run-'));
  const slug = `3154-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  process.env.SM_CLAUDE_BIN = writeClaudeStub();
  const job = { slug, cwd: mainCwd, agentType, ...(jobEpic ? { epicId: jobEpic } : {}) };
  try {
    const result = await executeJob(job, runDir, mainCwd, () => Promise.resolve(), undefined, resumeTarget);
    const argv = JSON.parse(fs.readFileSync(path.join(mainCwd, 'argv.marker'), 'utf8'));
    return { result, argv };
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function pluginDirs(argv) {
  const out = [];
  argv.forEach((a, i) => { if (a === '--plugin-dir') out.push(argv[i + 1]); });
  return out;
}

// ---------- buildClaudeSpawnArgs ----------

test('buildClaudeSpawnArgs: pluginDirArgs land before --dangerously-skip-permissions; default adds none', () => {
  const args = buildClaudeSpawnArgs({ model: 'opus', sessionId: 's', resume: false, pluginDirArgs: ['--plugin-dir', '/a', '--plugin-dir', '/b'] });
  const skip = args.indexOf('--dangerously-skip-permissions');
  expect(args.indexOf('--plugin-dir')).toBeGreaterThanOrEqual(0);
  expect(args.lastIndexOf('/b')).toBeLessThan(skip);
  expect(args.slice(skip - 4, skip)).toEqual(['--plugin-dir', '/a', '--plugin-dir', '/b']);
  expect(buildClaudeSpawnArgs({ model: 'opus', sessionId: 's', resume: false })).not.toContain('--plugin-dir');
});

// ---------- findEpicById ----------

test('findEpicById: returns the row by key or id, null on miss, never throws', () => {
  const index = { sessions: { 'e-1': { id: 'e-1', packs: ['x'] }, k: { id: 'e-2' } } };
  const deps = { readActiveIndex: () => index };
  expect(agentModelResolve.findEpicById('/c', 'e-1', deps)).toEqual(index.sessions['e-1']);
  expect(agentModelResolve.findEpicById('/c', 'e-2', deps)).toEqual(index.sessions.k);
  expect(agentModelResolve.findEpicById('/c', 'nope', deps)).toBeNull();
  expect(agentModelResolve.findEpicById('/c', null, deps)).toBeNull();
  expect(agentModelResolve.findEpicById('/c', 'e-1', { readActiveIndex: () => { throw new Error('boom'); } })).toBeNull();
});

// ---------- executeJob ----------

test('executeJob: an Epic with packs adds --plugin-dir and appends laws after the persona body', async () => {
  const calls = [];
  stubCatalog(calls);
  const { result, argv } = await runJob({ epic: { id: 'epic-1', packs: ['test-pack'] } });
  expect(result.exitCode).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0].packIds).toEqual(['test-pack']);
  expect(pluginDirs(argv)).toEqual(['/abs/packs/test-pack']);
  expect(argv.indexOf('--plugin-dir')).toBeLessThan(argv.indexOf('--dangerously-skip-permissions'));
  expect(argv.filter((a) => a === '--append-system-prompt')).toHaveLength(1);
  expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(`You are dev-lead.\n\n${LAWS}`);
});

test('executeJob: Epic found via sourcePromptId; laws alone when there is no persona', async () => {
  stubCatalog([]);
  const mainEpic = { id: 'epic-src', packs: ['test-pack'] };
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-packs-src-'));
  const psDir = path.join(mainCwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(psDir, { recursive: true });
  fs.writeFileSync(path.join(psDir, 'active-index.json'), JSON.stringify({ sessions: { [mainEpic.id]: mainEpic } }));
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  const slug = `3154-src-${process.pid}`;
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-packs-srcrun-'));
  process.env.SM_CLAUDE_BIN = writeClaudeStub();
  try {
    const result = await executeJob({ slug, cwd: mainCwd, agentType: null, sourcePromptId: 'epic-src' }, runDir, mainCwd, () => Promise.resolve());
    const argv = JSON.parse(fs.readFileSync(path.join(mainCwd, 'argv.marker'), 'utf8'));
    expect(result.exitCode).toBe(0);
    expect(pluginDirs(argv)).toEqual(['/abs/packs/test-pack']);
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(LAWS);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('executeJob: the persona cap applies to the persona body only, never to laws', async () => {
  const bigLaws = 'L'.repeat(agentModelResolve.AGENT_BODY_CHAR_CAP + 500);
  packSpawnArgs.composePackSpawnArgs = () => ({ pluginDirArgs: ['--plugin-dir', '/abs/p'], laws: bigLaws, unknown: [] });
  const { argv } = await runJob({ epic: { id: 'epic-1', packs: ['p'] } });
  const sp = argv[argv.indexOf('--append-system-prompt') + 1];
  expect(sp).toBe(`You are dev-lead.\n\n${bigLaws}`);
  expect(sp).not.toContain('[Truncated');
});

test('executeJob: a resume spawn keeps the packs', async () => {
  const calls = [];
  stubCatalog(calls);
  const { argv } = await runJob({
    epic: { id: 'epic-1', packs: ['test-pack'] },
    resumeTarget: { sessionId: 'resume-sid-3154', dirtyPaths: [] },
  });
  expect(argv).toContain('--resume');
  expect(calls).toHaveLength(1);
  expect(pluginDirs(argv)).toEqual(['/abs/packs/test-pack']);
  expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(`You are dev-lead.\n\n${LAWS}`);
});

test('executeJob: no Epic, an Epic without packs, or an unreadable index spawns with today\'s argv', async () => {
  stubCatalog([]);
  for (const opts of [
    { jobEpic: null },
    { epic: { id: 'epic-1' } },
    { epic: { id: 'epic-1', packs: [] } },
    { rawIndex: '{not json' },
    { epic: { id: 'other', packs: ['test-pack'] } },
  ]) {
    const { result, argv } = await runJob(opts);
    expect(result.exitCode).toBe(0);
    expect(argv).not.toContain('--plugin-dir');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('You are dev-lead.');
  }
});

test('executeJob: a pack lookup error spawns with today\'s argv', async () => {
  packSpawnArgs.composePackSpawnArgs = () => { throw new Error('catalog exploded'); };
  const { result, argv } = await runJob({ epic: { id: 'epic-1', packs: ['test-pack'] } });
  expect(result.exitCode).toBe(0);
  expect(argv).not.toContain('--plugin-dir');
  expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('You are dev-lead.');
});
