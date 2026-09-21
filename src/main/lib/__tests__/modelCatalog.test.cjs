'use strict';
import { describe, it, expect, vi } from 'vitest';
const { resolveModelCatalog, CATALOG_FLOOR, parseAliases, parseEffortLevels, scanModelIds } = require('../modelCatalog.cjs');

const MODEL_OUT = 'Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.';
const EFFORT_OUT = 'Usage: /effort <low|medium|high|xhigh|max|auto>';
const NOW = Date.parse('2026-09-20T00:00:00Z');

function mk(over = {}) {
  const files = over.files || {};
  const fsImpl = {
    readFileSync: (f) => { if (f in files) return files[f]; if (String(f).endsWith('claude-settings-schema.json')) return JSON.stringify({ properties: { effortLevel: { enum: ['low', 'medium', 'high', 'xhigh'] } } }); throw new Error('ENOENT'); },
    realpathSync: (p) => p,
  };
  const runClaudeP = vi.fn(async (prompt) => ({ ok: true, out: prompt === '/model' ? MODEL_OUT : EFFORT_OUT }));
  const writeJson = vi.fn(async () => {});
  const deps = {
    env: {}, now: () => NOW, userDataDir: () => '/ud', homeDir: () => '/home/u', projectRootOf: (c) => c,
    probeClaudeVersion: async () => '2.1.277', resolveClaudeBin: () => '/bin/claude',
    scanModelIds: () => ['claude-opus-5', 'claude-sonnet-5'], fs: fsImpl, runClaudeP, writeJson, ...over.deps,
  };
  return { deps, runClaudeP, writeJson };
}
const CACHE = '/ud/model-catalog.json';
const cacheEntry = (o = {}) => JSON.stringify({ aliases: ['sonnet'], models: ['claude-old-1'], effortLevels: ['low'], settingsEffortLevels: ['low'], claudeVersion: '2.1.277', probedAt: new Date(NOW - 1000).toISOString(), degraded: false, ...o });

describe('parsers', () => {
  it('parses aliases, dropping the "or a full model ID" clause and keeping [1m]', () => {
    expect(parseAliases(`Current model: x\n${MODEL_OUT}`)).toEqual(['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan', 'default']);
  });
  it('parses effort levels', () => {
    expect(parseEffortLevels(EFFORT_OUT)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
  });
  it('returns null on garbage', () => {
    expect(parseAliases('nope')).toBeNull();
    expect(parseEffortLevels('nope')).toBeNull();
  });
});

describe('scanModelIds', () => {
  const scanBuf = (content, opts) => {
    const data = Buffer.from(content, 'latin1');
    let pos = 0;
    const fsImpl = {
      openSync: () => 1, closeSync: () => {},
      readSync: (fd, buf, off, len) => { const n = Math.min(len, data.length - pos); data.copy(buf, off, pos, pos + n); pos += n; return n; },
    };
    return scanModelIds('/x', { fsImpl, ...opts });
  };
  it('finds an id split across a chunk boundary', () => {
    const content = 'x'.repeat(13) + 'claude-opus-4-8' + '\0' + 'y'.repeat(20) + 'claude-haiku-4-5-20251001\0';
    // chunk 20 cuts the first id after "claude-opus" (offset 13..28)
    expect(scanBuf(content, { chunkSize: 20, overlap: 64 })).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-4-8']);
  });
  it('does not report a truncated id when the tail is cut mid-number', () => {
    expect(scanBuf('aaaaclaude-opus-4-8zz', { chunkSize: 14, overlap: 64 })).toEqual(['claude-opus-4-8']);
  });
});

describe('resolveModelCatalog', () => {
  it('happy path: merges probes, binary, schema, allowlist and writes cache', async () => {
    const t = mk({ files: { '/home/u/.claude/settings.json': JSON.stringify({ availableModels: ['opus', 'haiku'] }), '/p/.claude/settings.local.json': JSON.stringify({ availableModels: ['haiku', 'sonnet'] }) } });
    const c = await resolveModelCatalog({ cwd: '/p', force: true, deps: t.deps });
    expect(c.aliases).toContain('opus[1m]');
    expect(c.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
    expect(c.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(c.settingsEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(c.availableModels).toEqual(['opus', 'haiku', 'sonnet']);
    expect(c.sources).toEqual({ aliases: 'probe', models: 'binary', effortLevels: 'probe' });
    expect(c.degraded).toBe(false);
    expect(c.claudeVersion).toBe('2.1.277');
    expect(t.runClaudeP).toHaveBeenCalledWith('/model', { model: 'haiku', timeoutMs: 45000 });
    expect(t.runClaudeP).toHaveBeenCalledWith('/effort', { model: 'haiku', timeoutMs: 45000 });
    expect(t.writeJson).toHaveBeenCalledWith(CACHE, c);
  });
  it('availableModels is null when no scope defines it', async () => {
    const c = await resolveModelCatalog({ cwd: '/p', force: true, deps: mk().deps });
    expect(c.availableModels).toBeNull();
  });
  it('fresh matching cache is returned without spawning; force bypasses it', async () => {
    const t = mk({ files: { [CACHE]: cacheEntry() } });
    const c = await resolveModelCatalog({ deps: t.deps });
    expect(c.aliases).toEqual(['sonnet']);
    expect(c.sources.aliases).toBe('cache');
    expect(t.runClaudeP).not.toHaveBeenCalled();
    await resolveModelCatalog({ force: true, deps: t.deps });
    expect(t.runClaudeP).toHaveBeenCalledTimes(2);
  });
  it('probe timeout falls back to stale cache and marks degraded', async () => {
    const t = mk({ files: { [CACHE]: cacheEntry({ probedAt: new Date(NOW - 48 * 3600e3).toISOString() }) }, deps: { runClaudeP: vi.fn(async () => ({ ok: false, error: 'timeout' })) } });
    const c = await resolveModelCatalog({ deps: t.deps });
    expect(c.aliases).toEqual(['sonnet']);
    expect(c.effortLevels).toEqual(['low']);
    expect(c.sources.aliases).toBe('cache');
    expect(c.sources.effortLevels).toBe('cache');
    expect(c.sources.models).toBe('binary');
    expect(c.degraded).toBe(true);
    expect(t.writeJson).not.toHaveBeenCalled();
  });
  it('stale cache from a different CLI version is used before the floor; no cache → floor', async () => {
    const fail = { runClaudeP: vi.fn(async () => ({ ok: false })), scanModelIds: () => { throw new Error('ENOENT'); } };
    const stale = mk({ files: { [CACHE]: cacheEntry({ claudeVersion: '1.0.0' }) }, deps: fail });
    const c1 = await resolveModelCatalog({ deps: stale.deps });
    expect(c1.aliases).toEqual(['sonnet']);
    expect(c1.models).toEqual(['claude-old-1']);
    const none = mk({ deps: fail });
    const c2 = await resolveModelCatalog({ deps: none.deps });
    expect(c2.aliases).toEqual(CATALOG_FLOOR.aliases);
    expect(c2.effortLevels).toEqual(CATALOG_FLOOR.effortLevels);
    expect(c2.models).toEqual([]);
    expect(c2.sources).toEqual({ aliases: 'floor', models: 'floor', effortLevels: 'floor' });
    expect(c2.degraded).toBe(true);
  });
  it('corrupt cache degrades to floor without throwing', async () => {
    const t = mk({ files: { [CACHE]: '{not json' }, deps: { runClaudeP: vi.fn(async () => ({ ok: false })) } });
    const c = await resolveModelCatalog({ deps: t.deps });
    expect(c.aliases).toEqual(CATALOG_FLOOR.aliases);
  });
  it('single-flight collapses concurrent calls into one probe pair', async () => {
    const t = mk();
    const [a, b] = await Promise.all([resolveModelCatalog({ force: true, deps: t.deps }), resolveModelCatalog({ force: true, deps: t.deps })]);
    expect(a).toBe(b);
    expect(t.runClaudeP).toHaveBeenCalledTimes(2);
  });
  it('SM_E2E=1 never spawns: floor, or a cache when present', async () => {
    const t = mk({ deps: { env: { SM_E2E: '1' } } });
    const c = await resolveModelCatalog({ force: true, deps: t.deps });
    expect(c.aliases).toEqual(CATALOG_FLOOR.aliases);
    expect(t.runClaudeP).not.toHaveBeenCalled();
    const t2 = mk({ files: { [CACHE]: cacheEntry() }, deps: { env: { SM_E2E: '1' } } });
    expect((await resolveModelCatalog({ deps: t2.deps })).aliases).toEqual(['sonnet']);
    expect(t2.runClaudeP).not.toHaveBeenCalled();
  });
});
