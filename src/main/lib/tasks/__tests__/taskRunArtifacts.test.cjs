/**
 * taskRunArtifacts.test.cjs — a Task run gets SM_ARTIFACTS_DIR (a staging folder
 * outside the repo) and that folder is ingested into artifacts/_tasks/<taskId>/
 * when the run ends.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskRunArtifacts.test.cjs
 */
'use strict';

import { test, expect, describe, afterEach, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeClaudeStub, reapClaudeStubs } = require('../../../../../tests/helpers/claudeStub.cjs');
const { buildTaskEnv, runTask } = require('../taskRun.cjs');
const { opsPath } = require('../../opsOwnership.cjs');

describe('runTask artifacts staging', () => {
  const saved = {};
  const KEYS = ['SM_CLAUDE_BIN', 'SM_JOB_MEMORY_MAX_MB', 'SM_WORKTREE_ROOT'];
  let dir;
  let project;
  let wtRoot;
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskrun-art-'));
    project = path.join(dir, 'project');
    wtRoot = path.join(dir, 'worktrees');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(wtRoot, { recursive: true });
    process.env.SM_WORKTREE_ROOT = wtRoot;
    process.env.SM_JOB_MEMORY_MAX_MB = '0'; // no systemd scope in tests
    process.env.SM_CLAUDE_BIN = writeClaudeStub({
      body: `
if (process.argv.indexOf('-p') < 0) { process.stdout.write('stub 0.0.0\\n'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
const d = process.env.SM_ARTIFACTS_DIR || null;
if (d) fs.writeFileSync(path.join(d, 'report.md'), '# hello\\n');
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ dir: d }) }));
process.exit(0);
`,
    });
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    reapClaudeStubs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deps = { writeToolRiskGuardSettingsFile: async () => null };
  const env = () => buildTaskEnv({}, { PATH: process.env.PATH, HOME: process.env.HOME });

  test('sets SM_ARTIFACTS_DIR to the staging folder and ingests it into artifacts/_tasks/<taskId>/ at run end', async () => {
    const taskId = 'task-abc-123';
    const r = await runTask({ deps, args: ['-p'], env: env(), prompt: 'x', cwd: project, projectRoot: project, taskId, timeoutMs: 30_000 });
    expect(r.status).toBe('ok');

    const staging = path.join(wtRoot, 'artifact-staging', taskId);
    const seen = JSON.parse(r.envelope.result);
    expect(seen.dir).toBe(staging);
    // Outside the repo.
    expect(path.relative(project, staging).startsWith('..')).toBe(true);

    const storeDir = opsPath(project, 'artifacts', '_tasks', taskId);
    expect(fs.readFileSync(path.join(storeDir, 'report.md'), 'utf8')).toBe('# hello\n');
    const ledger = JSON.parse(fs.readFileSync(path.join(storeDir, 'index.json'), 'utf8'));
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ name: 'report.md', kind: 'doc', producer: { taskId } });
    // Source removed after a successful copy, and the emptied staging folder itself removed.
    expect(fs.existsSync(staging)).toBe(false);
    expect(r.artifacts.published).toHaveLength(1);
    expect(r.artifacts.skipped).toEqual([]);
  });

  test('real store + real git: the Task-end harvest into artifacts/_tasks/<taskId>/ leaves nothing visible to git', async () => {
    const { execFileSync } = require('node:child_process');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'git-project-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const taskId = 'task-git-456';
    const r = await runTask({ deps, args: ['-p'], env: env(), prompt: 'x', cwd: root, projectRoot: root, taskId, timeoutMs: 30_000 });
    expect(r.status).toBe('ok');
    expect(r.artifacts.published).toHaveLength(1);
    const stored = path.join(root, 'session-manager-operations', 'artifacts', '_tasks', taskId, 'report.md');
    expect(r.artifacts.published[0].storedPath).toBe(stored);
    expect(() => execFileSync('git', ['check-ignore', '-q', stored], { cwd: root })).not.toThrow();
    expect(execFileSync('git', ['status', '--porcelain', '-uall', '--', 'session-manager-operations/artifacts'], { cwd: root, encoding: 'utf8' })).toBe('');
  });

  test('no taskId → no SM_ARTIFACTS_DIR and no ingest', async () => {
    const r = await runTask({ deps, args: ['-p'], env: env(), prompt: 'x', cwd: project, timeoutMs: 30_000 });
    expect(r.status).toBe('ok');
    expect(JSON.parse(r.envelope.result).dir).toBe(null);
    expect(r.artifacts).toBe(null);
    expect(fs.existsSync(path.join(wtRoot, 'artifact-staging'))).toBe(false);
  });

  test('an ingest failure is logged and never changes the run result', async () => {
    const store = {
      stagingDirFor: () => { const d = path.join(dir, 'stage'); fs.mkdirSync(d, { recursive: true }); return d; },
      ingestDir: async () => { throw new Error('disk gone'); },
    };
    const r = await runTask({ deps: { ...deps, artifactStore: store }, args: ['-p'], env: env(), prompt: 'x', cwd: project, taskId: 't1', timeoutMs: 30_000 });
    expect(r.status).toBe('ok');
    expect(r.artifacts).toBe(null);
  });

  test('a staging folder left non-empty after ingest is kept and logged', async () => {
    const stage = path.join(dir, 'stage-full');
    const logs = [];
    const orig = console.error;
    console.error = (...a) => { logs.push(a.join(' ')); };
    try {
      const store = {
        stagingDirFor: () => { fs.mkdirSync(stage, { recursive: true }); return stage; },
        ingestDir: async () => ({ published: [], skipped: [] }), // copies nothing → report.md stays
      };
      const r = await runTask({ deps: { ...deps, artifactStore: store }, args: ['-p'], env: env(), prompt: 'x', cwd: project, taskId: 't2', timeoutMs: 30_000 });
      expect(r.status).toBe('ok');
    } finally { console.error = orig; }
    expect(fs.readdirSync(stage)).toEqual(['report.md']);
    expect(logs.some((l) => l.includes('staging folder kept') && l.includes(stage))).toBe(true);
  });
});
