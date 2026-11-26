'use strict';
import { describe, it, expect } from 'vitest';
const { mcpReachWarnings } = require('../prdMcpReachWarnings.cjs');

const resolve = () => ({ known: { ok: {} }, credentialed: { cred: 'has TOKEN' } });
const input = (o = {}) => ({ cwd: '/p', ...o });

describe('mcpReachWarnings', () => {
  it('no warning for a resolvable server', () => {
    expect(mcpReachWarnings(input(), { resolve, readPersonaServers: () => ['ok'] })).toEqual([]);
  });
  it('warns for an undefined server', () => {
    const w = mcpReachWarnings(input(), { resolve, readPersonaServers: () => ['nope'] });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('nope');
    expect(w[0]).toContain('capability_unknown');
  });
  it('warns for a credentialed server', () => {
    const w = mcpReachWarnings(input(), { resolve, readPersonaServers: () => ['cred'] });
    expect(w[0]).toContain('capability_credentialed');
  });
  it('warns when a riskTools server is not in the persona', () => {
    const w = mcpReachWarnings(input({ riskTools: ['mcp__other__publish', 'mcp__ok__x'] }), { resolve, readPersonaServers: () => ['ok'] });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('other');
  });
  it('no warning and no throw when the persona is unreadable', () => {
    expect(mcpReachWarnings(input({ riskTools: ['mcp__a__b'] }), { resolve, readPersonaServers: () => null })).toEqual([]);
    expect(mcpReachWarnings(input(), { resolve, readPersonaServers: () => { throw new Error('x'); } })).toEqual([]);
  });
});
