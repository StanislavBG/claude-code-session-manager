/**
 * taskRun.test.cjs — Task spawn primitive (lib/tasks/taskRun.cjs): golden argv,
 * env, and runTask against a fake claude binary.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskRun.test.cjs
 */
'use strict';

import { test, expect, describe, afterEach, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeClaudeStub, reapClaudeStubs } = require('../../../../../tests/helpers/claudeStub.cjs');
const { buildTaskArgs, buildTaskEnv, runTask, textStdoutFor } = require('../taskRun.cjs');

const PROJ = path.resolve(os.tmpdir(), 'sm-taskrun-proj');

describe('buildTaskArgs', () => {
  test('distill-like call: sessionId + allowedTools [] + setting-sources empty', () => {
    const args = buildTaskArgs({
      model: 'haiku', effort: 'low', projectCwd: PROJ,
      runtime: { sessionId: 'sid-1', allowedTools: [], settingSources: '', cwd: '/elsewhere' },
    });
    expect(args).toEqual([
      '-p', '--model', 'haiku', '--effort', 'low',
      '--session-id', 'sid-1',
      '--no-session-persistence',
      '--setting-sources', '',
      '--allowedTools', '',
      '--output-format', 'json',
    ]);
  });

  test('writer-like call: relative mcpConfig resolved against projectCwd, never runtime.cwd', () => {
    const args = buildTaskArgs({
      model: 'sonnet', effort: 'medium', projectCwd: PROJ,
      runtime: {
        cwd: '/somewhere/else', mcpConfig: ['cfg/mcp.json', '/abs/other.json'], strictMcpConfig: true,
        maxTurns: 12, systemPrompt: 'SYS', dangerouslySkipPermissions: true, tools: ['Read', 'Write'],
        disableAutoMemory: true,
      },
    });
    expect(args).toEqual([
      '-p', '--model', 'sonnet', '--effort', 'medium',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--max-turns', '12',
      '--system-prompt', 'SYS',
      '--dangerously-skip-permissions',
      '--mcp-config', path.join(PROJ, 'cfg/mcp.json'), '/abs/other.json',
      '--tools', 'Read,Write',
      '--output-format', 'json',
    ]);
    expect(args).not.toContain('--append-system-prompt');
    const env = buildTaskEnv({ disableAutoMemory: true }, { A: '1' });
    expect(env).toEqual({ A: '1', SM_KG_INTERNAL: '1', SM_PROC_ROLE: 'aux', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  test('env: no auto-memory flag unless === true; no caller env leaks in', () => {
    expect(buildTaskEnv({ disableAutoMemory: 'yes', FOO: 'x' }, { B: '2' }))
      .toEqual({ B: '2', SM_KG_INTERNAL: '1', SM_PROC_ROLE: 'aux' });
  });

  test('first resumable call: persistSession drops --no-session-persistence', () => {
    const args = buildTaskArgs({ model: 'sonnet', effort: 'high', runtime: { sessionId: 's2', persistSession: true } });
    expect(args).toEqual(['-p', '--model', 'sonnet', '--effort', 'high', '--session-id', 's2', '--output-format', 'json']);
  });

  test('resume call', () => {
    const args = buildTaskArgs({ model: 'sonnet', effort: 'high', runtime: { resume: 's2' } });
    expect(args).toEqual(['-p', '--model', 'sonnet', '--effort', 'high', '--resume', 's2', '--output-format', 'json']);
  });

  test('tools [] vs absent', () => {
    const withEmpty = buildTaskArgs({ model: 'm', effort: 'e', runtime: { tools: [] } });
    const i = withEmpty.indexOf('--tools');
    expect(i).toBeGreaterThan(0);
    expect(withEmpty[i + 1]).toBe('');
    expect(buildTaskArgs({ model: 'm', effort: 'e', runtime: {} })).not.toContain('--tools');
    expect(buildTaskArgs({ model: 'm', effort: 'e', runtime: {} })).not.toContain('--allowedTools');
  });

  test('stream-json is last, followed by --verbose; variadics precede it', () => {
    const args = buildTaskArgs({ model: 'm', effort: 'e', runtime: { outputFormat: 'stream-json', allowedTools: ['Read'], mcpConfig: ['a.json'] } });
    expect(args.slice(-3)).toEqual(['--output-format', 'stream-json', '--verbose']);
    expect(args.indexOf('--allowedTools')).toBeLessThan(args.indexOf('--output-format'));
    expect(args.indexOf('--mcp-config')).toBeLessThan(args.indexOf('--output-format'));
  });

  test('throws on empty model/effort and on an argv element over 100 KiB; never includes the prompt', () => {
    expect(() => buildTaskArgs({ model: '', effort: 'e' })).toThrow();
    expect(() => buildTaskArgs({ model: 'm', effort: '' })).toThrow();
    expect(() => buildTaskArgs({ model: 'm', effort: 'e', runtime: { systemPrompt: 'x'.repeat(100 * 1024 + 1) } }))
      .toThrow(expect.objectContaining({ code: 'argv_too_large' }));
    const args = buildTaskArgs({ model: 'm', effort: 'e', runtime: { prompt: 'SECRET PROMPT' } });
    expect(args).not.toContain('SECRET PROMPT');
  });

  test('textStdoutFor', () => {
    expect(textStdoutFor({ result: 'hello' })).toBe('hello\n');
    expect(textStdoutFor(null)).toBe('\n');
  });
});

describe('runTask (fake claude binary)', () => {
  const prevBin = process.env.SM_CLAUDE_BIN;
  const prevMem = process.env.SM_JOB_MEMORY_MAX_MB;
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskrun-'));
    process.env.SM_JOB_MEMORY_MAX_MB = '0'; // no systemd scope in tests
    process.env.SM_CLAUDE_BIN = writeClaudeStub({
      body: `
if (process.argv.indexOf('-p') < 0) { process.stdout.write('stub 0.0.0\\n'); process.exit(0); }
const prompt = readPrompt();
const mode = process.env.TASK_STUB_MODE || 'json';
const env = { session_id: 'sess-9', usage: { input_tokens: 3 }, modelUsage: { m: {} }, total_cost_usd: 0.01, num_turns: 2 };
if (mode === 'json') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'echo:' + prompt, ...env }));
  process.exit(0);
}
if (mode === 'stream') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'streamed', ...env }) + '\\n');
  process.exit(0);
}
if (mode === 'fail') {
  process.stderr.write('boom');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'bad' }));
  process.exit(3);
}
if (mode === 'ratelimit') {
  process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your limit" }) + '\\n');
  process.exit(1);
}
if (mode === 'hang') { setInterval(() => {}, 1000); }
`,
    });
  });
  afterEach(() => {
    if (prevBin === undefined) delete process.env.SM_CLAUDE_BIN; else process.env.SM_CLAUDE_BIN = prevBin;
    if (prevMem === undefined) delete process.env.SM_JOB_MEMORY_MAX_MB; else process.env.SM_JOB_MEMORY_MAX_MB = prevMem;
    reapClaudeStubs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const envFor = (mode) => buildTaskEnv({}, { PATH: process.env.PATH, HOME: process.env.HOME, TASK_STUB_MODE: mode });

  test('json envelope', async () => {
    let pid = null;
    const r = await runTask({ args: buildTaskArgs({ model: 'm', effort: 'e' }), env: envFor('json'), prompt: 'hi', cwd: dir, timeoutMs: 30_000, onSpawn: (p) => { pid = p; } });
    expect(pid).toBeGreaterThan(0);
    expect(r.status).toBe('ok');
    expect(r.exitCode).toBe(0);
    expect(r.envelope.result).toBe('echo:hi');
    expect(r.sessionId).toBe('sess-9');
    expect(r.usage).toEqual({ input_tokens: 3 });
    expect(r.modelUsage).toEqual({ m: {} });
    expect(r.cliCostUsd).toBe(0.01);
    expect(r.numTurns).toBe(2);
    expect(r.quota).toEqual({ rateLimited: false, resetsAt: null });
    expect(typeof r.durationMs).toBe('number');
  });

  test('stream-json: last result line', async () => {
    const r = await runTask({ args: buildTaskArgs({ model: 'm', effort: 'e', runtime: { outputFormat: 'stream-json' } }), env: envFor('stream'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    expect(r.status).toBe('ok');
    expect(r.envelope.result).toBe('streamed');
    expect(textStdoutFor(r.envelope)).toBe('streamed\n');
  });

  test('non-zero exit → error with stderr tail', async () => {
    const r = await runTask({ args: ['-p'], env: envFor('fail'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    expect(r.status).toBe('error');
    expect(r.exitCode).toBe(3);
    expect(r.stderrTail).toContain('boom');
    expect(r.sessionId).toBeNull();
  });

  test('timeout kills the tree', async () => {
    const r = await runTask({ args: ['-p'], env: envFor('hang'), prompt: 'x', cwd: dir, timeoutMs: 500 });
    expect(r.status).toBe('timeout');
  });

  test('abort → caller_gone', async () => {
    const ac = new AbortController();
    const p = runTask({ args: ['-p'], env: envFor('hang'), prompt: 'x', cwd: dir, timeoutMs: 30_000, signal: ac.signal, onSpawn: () => setTimeout(() => ac.abort(), 200) });
    const r = await p;
    expect(r.status).toBe('caller_gone');
  });

  test('rate limit', async () => {
    const r = await runTask({ args: ['-p'], env: envFor('ratelimit'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    expect(r.status).toBe('rate_limited');
    expect(r.quota.rateLimited).toBe(true);
    expect(r.quota.resetsAt).toBe(new Date(1900000000 * 1000).toISOString());
  });

  test('spawn failure never throws', async () => {
    process.env.SM_CLAUDE_BIN = path.join(dir, 'does-not-exist');
    const r = await runTask({ args: ['-p'], env: envFor('json'), prompt: 'x', cwd: dir, timeoutMs: 5_000 });
    expect(r.status).toBe('spawn_failed');
  });
});
