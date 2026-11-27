'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/personaToolScope-strict.test.cjs
//
// personaToolScopeArgs is fail-closed: --strict-mcp-config is always present,
// only the declared / tool-named servers that resolve in the known map are
// passed, and any unknown server or pack comes back as a refusal naming it —
// never a widened (every-server) argv.

const assert = require('node:assert/strict');
const { personaToolScopeArgs, buildPersonaToolScope } = require('../personaToolScope.cjs');

const entry = { command: 'node', args: ['/x/server.cjs'] };
const other = { command: 'node', args: ['/x/other.cjs'] };
const known = { 'session-manager-scheduler': entry, blender: other };

function mcpConfigOf(args) {
  const i = args.indexOf('--mcp-config');
  return i === -1 ? null : JSON.parse(args[i + 1]).mcpServers;
}

describe('personaToolScopeArgs strict capabilities', () => {
  it('one unknown tool-named server: refused, never widened', () => {
    const scope = buildPersonaToolScope(['Read', 'mcp__session-manager-scheduler__x', 'mcp__ghost__t']);
    const r = personaToolScopeArgs(scope, { mcpServers: known });
    assert.deepEqual(r.refusal, { code: 'capability_unknown', name: 'ghost' });
    assert.ok(r.args.includes('--strict-mcp-config'));
    const cfg = mcpConfigOf(r.args);
    assert.ok(cfg === null || !('ghost' in cfg));
    assert.ok(!cfg || !('blender' in cfg), 'an unnamed known server is never added');
  });

  it('one unknown declared server: refused, strict mode kept', () => {
    const r = personaToolScopeArgs(buildPersonaToolScope(['Read']), { mcpServers: known, declaredServers: ['nope'] });
    assert.deepEqual(r.refusal, { code: 'capability_unknown', name: 'nope' });
    assert.ok(r.args.includes('--strict-mcp-config'));
  });

  it('all known: exactly the declared + tool-named set, strict', () => {
    const scope = buildPersonaToolScope(['mcp__session-manager-scheduler__x']);
    const r = personaToolScopeArgs(scope, { mcpServers: known, declaredServers: ['blender'] });
    assert.equal(r.refusal, null);
    assert.deepEqual(mcpConfigOf(r.args), { 'session-manager-scheduler': entry, blender: other });
    const i = r.args.indexOf('--mcp-config');
    assert.equal(r.args[i + 2], '--strict-mcp-config');
  });

  it('no MCP tools and nothing declared: strict, no --mcp-config', () => {
    const r = personaToolScopeArgs(buildPersonaToolScope(['Read', 'Bash']), { mcpServers: known });
    assert.equal(r.refusal, null);
    assert.equal(r.args[r.args.length - 1], '--strict-mcp-config');
    assert.ok(!r.args.includes('--mcp-config'));
  });

  it('unscoped persona still runs strict with only its declared servers', () => {
    const none = personaToolScopeArgs(null, { mcpServers: known });
    assert.deepEqual(none, { args: ['--strict-mcp-config'], refusal: null });
    const decl = personaToolScopeArgs(null, { mcpServers: known, declaredServers: ['blender'] });
    assert.equal(decl.refusal, null);
    assert.deepEqual(mcpConfigOf(decl.args), { blender: other });
    assert.ok(!decl.args.includes('--agents'));
  });

  it('an unknown pack: refused naming the pack', () => {
    const r = personaToolScopeArgs(buildPersonaToolScope(['Read']), {
      mcpServers: known, packs: ['web', 'mystery'], knownPacks: ['web'],
    });
    assert.deepEqual(r.refusal, { code: 'capability_unknown', name: 'mystery' });
    assert.ok(r.args.includes('--strict-mcp-config'));
    const ok = personaToolScopeArgs(null, { packs: ['web'], knownPacks: ['web'] });
    assert.equal(ok.refusal, null);
  });

  it('a malformed mcp__ tool (no server segment) is refused, not widened', () => {
    const r = personaToolScopeArgs({ tools: ['mcp__'] }, { mcpServers: known });
    assert.equal(r.refusal.code, 'capability_unknown');
    assert.ok(r.args.includes('--strict-mcp-config'));
  });
  // Probe 2026-11-27 (CLI 2.1.330): the --agents tools array scopes MCP tools,
  // so a declared server whose tools it never names is loaded but invisible.
  it('a declared server is granted whole in the scoped agent tools', () => {
    const agentTools = (args) => JSON.parse(args[args.indexOf('--agents') + 1])['sm-headless-scoped'].tools;
    const r = personaToolScopeArgs(buildPersonaToolScope(['Read', 'Bash']), {
      mcpServers: known, declaredServers: ['session-manager-scheduler'],
    });
    assert.equal(r.refusal, null);
    assert.ok(agentTools(r.args).includes('mcp__session-manager-scheduler'));
    assert.deepEqual(mcpConfigOf(r.args), { 'session-manager-scheduler': entry });
    // A server named by a single tool stays narrowed to that tool.
    const narrow = personaToolScopeArgs(buildPersonaToolScope(['Read', 'mcp__blender__render']), {
      mcpServers: known, declaredServers: ['blender'],
    });
    assert.ok(!agentTools(narrow.args).includes('mcp__blender'));
    assert.ok(agentTools(narrow.args).includes('mcp__blender__render'));
    // An unknown declared server is refused, never granted.
    const bad = personaToolScopeArgs(buildPersonaToolScope(['Read']), { mcpServers: known, declaredServers: ['mystery'] });
    assert.ok(!agentTools(bad.args).includes('mcp__mystery'));
  });
});
