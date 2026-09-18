/**
 * proc-role-env.test.cjs — SM_PROC_ROLE attribution env + scripts/sm-ps.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/proc-role-env.test.cjs
 */
'use strict';

import { test, expect, describe, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { cleanChildEnv, withProcRole, inferProcRole } = require('../lib/cleanEnv.cjs');
const { runClaudeP } = require('../lib/runClaudeP.cjs');
const { runDocEdit } = require('../docEdit.cjs');

const SM_PS = path.join(__dirname, '..', '..', '..', 'scripts', 'sm-ps.cjs');

let tmp;
let savedBin;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-proc-role-'));
  savedBin = process.env.SM_CLAUDE_BIN;
});
afterEach(() => {
  if (savedBin === undefined) delete process.env.SM_CLAUDE_BIN; else process.env.SM_CLAUDE_BIN = savedBin;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Stub `claude` that prints {"after":"<SM_PROC_ROLE>"} — valid for both runClaudeP and docEdit. */
function writeStub() {
  const bin = path.join(tmp, 'claude-stub.sh');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf \'{"after":"%s"}\' "$SM_PROC_ROLE"\n', { mode: 0o755 });
  return bin;
}

describe('cleanChildEnv role stamping', () => {
  test('explicit role wins; inference from existing attribution vars; default aux', () => {
    expect(cleanChildEnv({ SM_PROC_ROLE: 'shell' }).SM_PROC_ROLE).toBe('shell');
    expect(inferProcRole({ SM_SCHEDULER_JOB_SLUG: 's' })).toBe('job');
    expect(inferProcRole({ SM_CHAT_SESSION_ID: 'c' })).toBe('chat');
    expect(inferProcRole({ SM_CHAT_SESSION_ID: 'c', SESSION_MANAGER_TAB_ID: 'c' })).toBe('shell');
    expect(cleanChildEnv().SM_PROC_ROLE).toBe('aux');
  });

  test('is additive: existing attribution vars survive and SM_PROC_ROOT is untouched', () => {
    const env = cleanChildEnv({ SM_SCHEDULER_JOB_SLUG: 'slug-1', SM_CHAT_SESSION_ID: 'chat-1', SM_PROJECT_ROOT: '/p' });
    expect(env).toMatchObject({ SM_PROC_ROLE: 'job', SM_SCHEDULER_JOB_SLUG: 'slug-1', SM_CHAT_SESSION_ID: 'chat-1', SM_PROJECT_ROOT: '/p' });
    expect('SM_PROC_ROOT' in env).toBe(process.env.SM_PROC_ROOT !== undefined);
  });

  test('withProcRole returns a copy and does not mutate its input', () => {
    const base = { A: '1' };
    expect(withProcRole(base, 'aux')).toEqual({ A: '1', SM_PROC_ROLE: 'aux' });
    expect(base).toEqual({ A: '1' });
  });
});

describe('real spawn paths carry SM_PROC_ROLE', () => {
  test('runClaudeP (bypasses cleanChildEnv)', async () => {
    process.env.SM_CLAUDE_BIN = writeStub();
    const r = await runClaudeP('hi');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.out).after).toBe('aux');
  });

  test('docEdit runClaude (bypasses cleanChildEnv)', async () => {
    process.env.SM_CLAUDE_BIN = writeStub();
    const r = await runDocEdit({ path: path.join(os.homedir(), 'x.md'), before: 'a', instruction: 'b', documentText: '' });
    expect(r).toEqual({ ok: true, after: 'aux' });
  });

  test('cleanChildEnv-built env reaches a spawned child', async () => {
    const out = await new Promise((resolve) => {
      const c = spawn('/bin/sh', ['-c', 'printf %s "$SM_PROC_ROLE"'], { env: cleanChildEnv({ SM_SCHEDULER_JOB_SLUG: 'x' }) });
      let s = '';
      c.stdout.on('data', (d) => { s += d; });
      c.on('close', () => resolve(s));
    });
    expect(out).toBe('job');
  });
});

describe('scripts/sm-ps.cjs', () => {
  test('--json lists a tagged stub child (and its descendant) with role, slug, project root', async () => {
    const env = cleanChildEnv({ SM_SCHEDULER_JOB_SLUG: 'fixture-slug', SM_PROJECT_ROOT: '/fixture/root' });
    // outer sh forks an inner sleep, so we also assert descendants are included
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { env, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const res = spawnSync(process.execPath, [SM_PS, '--json'], { encoding: 'utf8', timeout: 20000 });
      expect(res.status).toBe(0);
      const { processes } = JSON.parse(res.stdout);
      const hit = processes.find((p) => p.pid === child.pid);
      expect(hit).toMatchObject({ role: 'job', slug: 'fixture-slug', projectRoot: '/fixture/root', attributed: true });
      expect(processes.some((p) => p.ppid === child.pid)).toBe(true);
    } finally {
      try { process.kill(-child.pid); } catch { /* */ }
      child.kill('SIGKILL');
    }
  });

  test('exits 0 with an empty result set when nothing is running (empty proc root)', () => {
    const root = path.join(tmp, 'proc');
    fs.mkdirSync(root);
    const res = spawnSync(process.execPath, [SM_PS, '--json', '--proc-root', root], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ processes: [] });
  });

  test('degrades without attribution on unreadable environ / mid-scan exit, never crashes', () => {
    const root = path.join(tmp, 'proc');
    fs.mkdirSync(path.join(root, '100'), { recursive: true }); // comm-named ours, environ absent
    fs.writeFileSync(path.join(root, '100', 'stat'), '100 (sm-watchdog) S 1 0 0');
    fs.writeFileSync(path.join(root, '100', 'cmdline'), 'node\0x.js\0');
    fs.mkdirSync(path.join(root, '101')); // vanished: no stat at all
    const res = spawnSync(process.execPath, [SM_PS, '--json', '--proc-root', root], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const { processes } = JSON.parse(res.stdout);
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ pid: 100, comm: 'sm-watchdog', role: null, attributed: false });
  });
});
