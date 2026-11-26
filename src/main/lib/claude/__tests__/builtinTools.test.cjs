'use strict';

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { getBuiltinTools, FALLBACK_TOOLS, __resetForTests } = require('../builtinTools.cjs');

function fakeSpawn(lines, { hang = false } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = vi.fn();
    if (!hang) setImmediate(() => child.stdout.write(lines.join('\n') + '\n'));
    return child;
  };
  return { spawn, calls };
}

const init = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read', 'Agent', 'mcp__x__y', 'Skill'], skills: ['loop', 'run'] });

describe('getBuiltinTools', () => {
  beforeEach(() => { __resetForTests(); vi.useRealTimers(); });

  it('parses the init line and excludes mcp__ names', async () => {
    const { spawn, calls } = fakeSpawn(['{"type":"other"}', init]);
    const r = await getBuiltinTools({ spawn, claudeBin: 'claude', cliVersion: '1.0.0' });
    expect(r).toEqual({ tools: ['Read', 'Agent', 'Skill'], skills: ['loop', 'run'], source: 'cli', cliVersion: '1.0.0' });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--model', 'haiku', '-p', '--strict-mcp-config', '--setting-sources']));
    expect(calls[0].opts.shell).toBeUndefined();
  });

  it('caches per version', async () => {
    const { spawn, calls } = fakeSpawn([init]);
    await getBuiltinTools({ spawn, claudeBin: 'claude', cliVersion: '2.0.0' });
    const r = await getBuiltinTools({ spawn, claudeBin: 'claude', cliVersion: '2.0.0' });
    expect(r.source).toBe('cli');
    expect(calls).toHaveLength(1);
  });

  it('falls back on timeout', async () => {
    vi.useFakeTimers();
    const { spawn } = fakeSpawn([], { hang: true });
    const p = getBuiltinTools({ spawn, claudeBin: 'claude', cliVersion: '3.0.0' });
    await vi.advanceTimersByTimeAsync(20_001);
    const r = await p;
    expect(r.source).toBe('fallback');
    expect(r.tools).toEqual(FALLBACK_TOOLS);
  });

  it('falls back on malformed JSON', async () => {
    const { spawn } = fakeSpawn(['{not json']);
    const r = await getBuiltinTools({ spawn, claudeBin: 'claude', cliVersion: '4.0.0' });
    expect(r.source).toBe('fallback');
    expect(r.tools).toEqual(FALLBACK_TOOLS);
  });

  it('falls back when spawn throws', async () => {
    const r = await getBuiltinTools({ spawn: () => { throw new Error('boom'); }, claudeBin: 'claude', cliVersion: '5.0.0' });
    expect(r.source).toBe('fallback');
  });
});

describe('getBuiltinTools unknown version', () => {
  it('caches under "unknown" so the CLI spawns once per process', async () => {
    __resetForTests();
    const { spawn, calls } = fakeSpawn([init]);
    const a = await getBuiltinTools({ spawn, claudeBin: 'x', cliVersion: null });
    const b = await getBuiltinTools({ spawn, claudeBin: 'x', cliVersion: null });
    expect(a.tools).toEqual(b.tools);
    expect(calls.length).toBe(1);
  });
});
