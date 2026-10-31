import { describe, it, expect } from 'vitest';
const path = require('node:path');
const { ensureScopeOomPolicy, CONTENT } = require('../scopeOomPolicy.cjs');

const FILE = path.join('/cfg', 'systemd', 'user', 'app-claude-code-session-manager-.scope.d', '10-oom-policy.conf');

function harness({ existing = null, reload = { status: 0 }, probe = { status: 0 } } = {}) {
  const files = new Map();
  if (existing !== null) files.set(FILE, existing);
  const calls = [];
  const fs = {
    readFileSync(f) { if (!files.has(f)) throw new Error('ENOENT'); return files.get(f); },
  };
  const spawnSync = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return args.includes('daemon-reload') ? reload : probe;
  };
  const writeText = (f, t) => { files.set(f, t); };
  const run = (extra = {}) => ensureScopeOomPolicy({ platform: 'linux', configHome: '/cfg', fs, spawnSync, writeText, log: () => {}, ...extra });
  return { files, calls, run };
}
const reloads = (calls) => calls.filter((c) => c.includes('daemon-reload')).length;

describe('ensureScopeOomPolicy', () => {
  it('writes the drop-in and reloads once when missing', () => {
    const h = harness();
    expect(h.run()).toEqual({ applied: true, reason: 'written' });
    expect(h.files.get(FILE)).toBe(CONTENT);
    expect(CONTENT).toContain('[Scope]');
    expect(CONTENT).toContain('OOMPolicy=continue');
    expect(reloads(h.calls)).toBe(1);
  });
  it('is a no-op (no write, no reload) when content is identical', () => {
    const h = harness({ existing: CONTENT });
    const r = h.run();
    expect(r.applied).toBe(false);
    expect(reloads(h.calls)).toBe(0);
  });
  it('rewrites and reloads once when content differs', () => {
    const h = harness({ existing: '# hand\n' + CONTENT });
    expect(h.run()).toEqual({ applied: true, reason: 'updated' });
    expect(h.files.get(FILE)).toBe(CONTENT);
    expect(reloads(h.calls)).toBe(1);
  });
  it('skips on non-linux', () => {
    const h = harness();
    expect(h.run({ platform: 'darwin' })).toEqual({ applied: false, reason: 'not-linux' });
    expect(h.calls).toHaveLength(0);
  });
  it('reports no-systemctl without writing', () => {
    const h = harness({ probe: { error: new Error('ENOENT'), status: null } });
    expect(h.run()).toEqual({ applied: false, reason: 'no-systemctl' });
    expect(h.files.size).toBe(0);
  });
  it('does not throw when systemctl daemon-reload fails', () => {
    const h = harness({ reload: { status: 1 } });
    expect(h.run()).toEqual({ applied: false, reason: 'daemon-reload-failed' });
  });
  it('never throws when spawnSync throws', () => {
    const r = ensureScopeOomPolicy({ platform: 'linux', configHome: '/cfg', fs: {}, spawnSync() { throw new Error('boom'); } });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/boom/);
  });
});
