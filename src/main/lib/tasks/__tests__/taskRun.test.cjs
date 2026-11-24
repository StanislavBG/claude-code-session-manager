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
const { buildTaskArgs, buildTaskEnv, withToolRiskGuard, runTask, textStdoutFor, MAX_STDOUT_BYTES } = require('../taskRun.cjs');
const { writeToolRiskGuardSettingsFile } = require('../../epic/guardSpawnSettings.cjs');

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
      '--strict-mcp-config',
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
      '--settings', expect.any(String),
      '--mcp-config', path.join(PROJ, 'cfg/mcp.json'), '/abs/other.json',
      '--tools', 'Read,Write',
      '--output-format', 'json',
    ]);
    expect(args).not.toContain('--append-system-prompt');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(Array.isArray(settings.permissions.deny)).toBe(true);
    expect(settings.sandbox).toBeUndefined();
    const env = buildTaskEnv({ disableAutoMemory: true }, { A: '1' });
    expect(env).toEqual({ A: '1', SM_KG_INTERNAL: '1', SM_PROC_ROLE: 'aux', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  test('disallowedTools: each rule its own argv element, after --tools, before --output-format', () => {
    const args = buildTaskArgs({
      model: 'm', effort: 'e', projectCwd: PROJ,
      runtime: { tools: ['WebFetch', 'Read'], disallowedTools: ['WebFetch(domain:localhost)', 'WebFetch(domain:127.0.0.1)', 'Bash'] },
    });
    expect(args).toEqual([
      '-p', '--model', 'm', '--effort', 'e',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--tools', 'WebFetch,Read',
      '--disallowedTools', 'WebFetch(domain:localhost)', 'WebFetch(domain:127.0.0.1)', 'Bash',
      '--output-format', 'json',
    ]);
  });

  test('disallowedTools: an empty array sends no flag', () => {
    const args = buildTaskArgs({ model: 'm', effort: 'e', projectCwd: PROJ, runtime: { disallowedTools: [] } });
    expect(args).not.toContain('--disallowedTools');
  });

  test('appendSystemPrompt alone sits where --system-prompt would', () => {
    const args = buildTaskArgs({
      model: 'm', effort: 'e', projectCwd: PROJ,
      runtime: { maxTurns: 3, appendSystemPrompt: 'APP', dangerouslySkipPermissions: true, tools: ['Read'] },
    });
    expect(args).toEqual([
      '-p', '--model', 'm', '--effort', 'e',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--max-turns', '3',
      '--append-system-prompt', 'APP',
      '--dangerously-skip-permissions',
      '--settings', expect.any(String),
      '--tools', 'Read',
      '--output-format', 'json',
    ]);
    expect(args).not.toContain('--system-prompt');
  });

  test('appendSystemPrompt with systemPrompt: directly after the --system-prompt pair', () => {
    const args = buildTaskArgs({
      model: 'm', effort: 'e', projectCwd: PROJ,
      runtime: { systemPrompt: 'SYS', appendSystemPrompt: 'APP', disallowedTools: ['Bash(rm:*)'] },
    });
    expect(args).toEqual([
      '-p', '--model', 'm', '--effort', 'e',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--system-prompt', 'SYS',
      '--append-system-prompt', 'APP',
      '--disallowedTools', 'Bash(rm:*)',
      '--output-format', 'json',
    ]);
  });

  test('appendSystemPrompt over MAX_ARG_BYTES throws argv_too_large', () => {
    expect(() => buildTaskArgs({ model: 'm', effort: 'e', runtime: { appendSystemPrompt: 'x'.repeat(100 * 1024 + 1) } }))
      .toThrow(/exceeds/);
  });

  test('dangerouslySkipPermissions: tool-rules level denies home secrets', () => {
    const args = buildTaskArgs({ model: 'm', effort: 'e', projectCwd: PROJ, runtime: { dangerouslySkipPermissions: true } });
    const i = args.indexOf('--dangerously-skip-permissions');
    expect(args[i + 1]).toBe('--settings');
    const deny = JSON.parse(args[i + 2]).permissions.deny;
    const home = os.homedir().replace(/^\/+/, '');
    expect(deny).toContain(`Read(//${home}/.npmrc)`);
    expect(deny).toContain(`Edit(//${home}/.ssh/**)`);
  });

  test('no dangerouslySkipPermissions: no bypass flag, no --settings', () => {
    for (const runtime of [{}, { dangerouslySkipPermissions: 'yes' }, { dangerouslySkipPermissions: false }]) {
      const args = buildTaskArgs({ model: 'm', effort: 'e', projectCwd: PROJ, runtime });
      expect(args).toEqual(['-p', '--model', 'm', '--effort', 'e', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json']);
    }
  });

  test('env: no auto-memory flag unless === true; no caller env leaks in', () => {
    expect(buildTaskEnv({ disableAutoMemory: 'yes', FOO: 'x' }, { B: '2' }))
      .toEqual({ B: '2', SM_KG_INTERNAL: '1', SM_PROC_ROLE: 'aux' });
  });

  test('first resumable call: persistSession drops --no-session-persistence', () => {
    const args = buildTaskArgs({ model: 'sonnet', effort: 'high', runtime: { sessionId: 's2', persistSession: true } });
    expect(args).toEqual(['-p', '--model', 'sonnet', '--effort', 'high', '--session-id', 's2', '--strict-mcp-config', '--output-format', 'json']);
  });

  test('resume call', () => {
    const args = buildTaskArgs({ model: 'sonnet', effort: 'high', runtime: { resume: 's2' } });
    expect(args).toEqual(['-p', '--model', 'sonnet', '--effort', 'high', '--resume', 's2', '--strict-mcp-config', '--output-format', 'json']);
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

describe('withToolRiskGuard', () => {
  test('adds --settings <path> after -p and SM_TOOL_RISK_HEADLESS=1; never mutates inputs', () => {
    const args = buildTaskArgs({ model: 'm', effort: 'e', runtime: { allowedTools: ['Read'], mcpConfig: ['/a.json'] } });
    const env = buildTaskEnv({}, { A: '1' });
    const before = args.slice();
    const r = withToolRiskGuard({ args, env, settingsPath: '/h/.claude/session-manager/spawn-settings/tool-risk-x.json' });
    expect(r.args.slice(0, 3)).toEqual(['-p', '--settings', '/h/.claude/session-manager/spawn-settings/tool-risk-x.json']);
    expect(r.args.slice(3)).toEqual(before.slice(1));
    expect(r.env.SM_TOOL_RISK_HEADLESS).toBe('1');
    expect(r.env.SM_SCHEDULER_JOB_RISK_TOOLS).toBeUndefined();
    expect(args).toEqual(before);
    expect(env.SM_TOOL_RISK_HEADLESS).toBeUndefined();
  });
  test('null path: unchanged', () => {
    const args = ['-p', '--model', 'm'];
    const env = { A: '1' };
    const r = withToolRiskGuard({ args, env, settingsPath: null });
    expect(r.args).toEqual(args);
    expect(r.env).toEqual(env);
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
if (mode === 'split') {
  const fs = require('node:fs');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    const all = Buffer.from('alpha\\r\\nbé€ta\\n{"type":"result","is_error":false,"result":"split"}\\ntail-no-newline', 'utf8');
    // cut inside 'é' (2 bytes) and inside '€' (3 bytes)
    const cuts = [3, 9, 12, all.length];
    let at = 0;
    for (const c of cuts) { fs.writeSync(1, all.subarray(at, c)); at = c; await sleep(30); }
    process.exit(0);
  })();
}
if (mode === 'capped') {
  const fs = require('node:fs');
  const filler = JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) }) + '\\n';
  const chunk = filler.repeat(1024);
  let written = 0;
  while (written <= 9 * 1024 * 1024) { fs.writeSync(1, chunk); written += chunk.length; }
  fs.writeSync(1, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }) + '\\n');
  fs.writeSync(1, JSON.stringify({ type: 'result', is_error: false, result: 'late', ...env }) + '\\n');
  process.exit(0);
}
if (mode === 'longline') {
  const fs = require('node:fs');
  const piece = 'a'.repeat(1024 * 1024);
  for (let i = 0; i < 9; i++) fs.writeSync(1, piece);
  fs.writeSync(1, '\\nlast\\n');
  process.exit(0);
}
if (mode === 'argv') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ argv: process.argv.slice(2), headless: process.env.SM_TOOL_RISK_HEADLESS || null }), ...env }));
  process.exit(0);
}
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
  // The real settings writer, pointed at the temp dir — never the real ~/.claude.
  const deps = { writeToolRiskGuardSettingsFile: () => writeToolRiskGuardSettingsFile({ homeDir: dir, deps: { ensureShims: async () => null } }) };

  test('Task argv carries --settings <tool-risk file> and env SM_TOOL_RISK_HEADLESS=1', async () => {
    const r = await runTask({ deps, args: buildTaskArgs({ model: 'm', effort: 'e' }), env: envFor('argv'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    expect(r.status).toBe('ok');
    const seen = JSON.parse(r.envelope.result);
    const i = seen.argv.indexOf('--settings');
    expect(i).toBeGreaterThan(-1);
    const file = seen.argv[i + 1];
    expect(file.startsWith(path.join(dir, '.claude', 'session-manager', 'spawn-settings'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch|mcp__.*');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('guard-tool-risk.cjs');
    expect(seen.headless).toBe('1');
  });

  test('settings file unavailable: Task still runs, without --settings or the headless marker', async () => {
    const r = await runTask({
      args: buildTaskArgs({ model: 'm', effort: 'e' }), env: envFor('argv'), prompt: 'x', cwd: dir, timeoutMs: 30_000,
      deps: { writeToolRiskGuardSettingsFile: async () => null },
    });
    expect(r.status).toBe('ok');
    const seen = JSON.parse(r.envelope.result);
    expect(seen.argv).not.toContain('--settings');
    expect(seen.headless).toBeNull();
  });

  test('json envelope', async () => {
    let pid = null;
    const r = await runTask({ deps, args: buildTaskArgs({ model: 'm', effort: 'e' }), env: envFor('json'), prompt: 'hi', cwd: dir, timeoutMs: 30_000, onSpawn: (p) => { pid = p; } });
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
    const r = await runTask({ deps, args: buildTaskArgs({ model: 'm', effort: 'e', runtime: { outputFormat: 'stream-json' } }), env: envFor('stream'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    expect(r.status).toBe('ok');
    expect(r.envelope.result).toBe('streamed');
    expect(textStdoutFor(r.envelope)).toBe('streamed\n');
  });

  test('non-zero exit → error with stderr tail', async () => {
    const r = await runTask({ deps, args: ['-p'], env: envFor('fail'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    expect(r.status).toBe('error');
    expect(r.exitCode).toBe(3);
    expect(r.stderrTail).toContain('boom');
    expect(r.sessionId).toBeNull();
  });

  test('timeout kills the tree', async () => {
    const r = await runTask({ deps, args: ['-p'], env: envFor('hang'), prompt: 'x', cwd: dir, timeoutMs: 500 });
    expect(r.status).toBe('timeout');
  });

  test('abort → caller_gone', async () => {
    const ac = new AbortController();
    const p = runTask({ deps, args: ['-p'], env: envFor('hang'), prompt: 'x', cwd: dir, timeoutMs: 30_000, signal: ac.signal, onSpawn: () => setTimeout(() => ac.abort(), 200) });
    const r = await p;
    expect(r.status).toBe('caller_gone');
  });

  test('rate limit', async () => {
    const r = await runTask({ deps, args: ['-p'], env: envFor('ratelimit'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    expect(r.status).toBe('rate_limited');
    expect(r.quota.rateLimited).toBe(true);
    expect(r.quota.resetsAt).toBe(new Date(1900000000 * 1000).toISOString());
  });

  test('onStdoutLine: one call per line, in order, CR stripped, multi-byte chars intact, final unterminated line flushed', async () => {
    const lines = [];
    const r = await runTask({ deps, args: ['-p'], env: envFor('split'), prompt: 'x', cwd: dir, timeoutMs: 30_000, onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(['alpha', 'bé€ta', '{"type":"result","is_error":false,"result":"split"}', 'tail-no-newline']);
    expect(r.status).toBe('ok');
    expect(r.stdoutCapped).toBe(false);
  });

  test('a throwing onStdoutLine never changes the run result', async () => {
    const plain = await runTask({ deps, args: ['-p'], env: envFor('stream'), prompt: 'x', cwd: dir, timeoutMs: 30_000 });
    let calls = 0;
    const r = await runTask({ deps, args: ['-p'], env: envFor('stream'), prompt: 'x', cwd: dir, timeoutMs: 30_000, onStdoutLine: () => { calls++; throw new Error('hook boom'); } });
    expect(calls).toBe(2);
    const strip = (x) => ({ ...x, durationMs: 0 });
    expect(strip(r)).toEqual(strip(plain));
    expect(r.status).toBe('ok');
    expect(r.envelope.result).toBe('streamed');
  });

  test('stdout over the cap: later lines still delivered, result + rate limit survive the cap', async () => {
    let count = 0;
    let last = null;
    const r = await runTask({ deps, args: ['-p'], env: envFor('capped'), prompt: 'x', cwd: dir, timeoutMs: 60_000, onStdoutLine: (l) => { count++; last = l; } });
    expect(r.stdoutCapped).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(MAX_STDOUT_BYTES);
    expect(count).toBeGreaterThan(9 * 1024);
    expect(JSON.parse(last).result).toBe('late');
    expect(r.envelope.result).toBe('late');
    expect(r.usage).toEqual({ input_tokens: 3 });
    expect(r.modelUsage).toEqual({ m: {} });
    expect(r.cliCostUsd).toBe(0.01);
    expect(r.numTurns).toBe(2);
    expect(r.sessionId).toBe('sess-9');
    expect(r.quota.rateLimited).toBe(true);
    expect(r.quota.resetsAt).toBe(new Date(1900000000 * 1000).toISOString());
  }, 60_000);

  test('stdout over the cap without onStdoutLine: envelope still from the late result line', async () => {
    const r = await runTask({ deps, args: ['-p'], env: envFor('capped'), prompt: 'x', cwd: dir, timeoutMs: 60_000 });
    expect(r.stdoutCapped).toBe(true);
    expect(r.envelope.result).toBe('late');
    expect(r.sessionId).toBe('sess-9');
  }, 60_000);

  test('a single line longer than the cap is delivered truncated to MAX_STDOUT_BYTES', async () => {
    const lines = [];
    const r = await runTask({ deps, args: ['-p'], env: envFor('longline'), prompt: 'x', cwd: dir, timeoutMs: 60_000, onStdoutLine: (l) => lines.push(l.length) });
    expect(lines).toEqual([MAX_STDOUT_BYTES, 4]);
    expect(r.stdoutCapped).toBe(true);
  }, 60_000);

  test('spawn failure never throws', async () => {
    process.env.SM_CLAUDE_BIN = path.join(dir, 'does-not-exist');
    const r = await runTask({ deps, args: ['-p'], env: envFor('json'), prompt: 'x', cwd: dir, timeoutMs: 5_000 });
    expect(r.status).toBe('spawn_failed');
  });
});
