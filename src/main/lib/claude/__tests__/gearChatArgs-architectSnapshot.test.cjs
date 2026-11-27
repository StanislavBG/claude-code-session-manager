'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/gearChatArgs-architectSnapshot.test.cjs
//
// Regression pin for 828e5a57: the real architect AgentSnapshot (Hatch-Day report) declares
// mcpServers ['session-manager-scheduler'] but names no mcp__ tool. 0.144.0 emitted an --agents
// tools array without mcp__session-manager-scheduler, hiding the whole server from chat.

const assert = require('node:assert/strict');
const { personaToolScopeArgs, buildPersonaToolScope } = require('../personaToolScope.cjs');

const tools = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task'];
const snapshot = {
  name: 'architect',
  tools,
  mcpServers: ['session-manager-scheduler'],
  loadout: 'equipped',
  gearBindsChat: true,
  packs: ['session-manager-dev'],
};
const known = { 'session-manager-scheduler': { command: 'node', args: ['x.cjs'] } };

function jsonAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : JSON.parse(args[i + 1]);
}

function scopedTools(args) {
  const agents = jsonAfter(args, '--agents');
  assert.ok(agents && agents['sm-headless-scoped'], 'sm-headless-scoped agent present');
  return agents['sm-headless-scoped'].tools;
}

describe('architect snapshot gear (828e5a57 regression)', () => {
  it('gearChatArgs exposes the declared scheduler server', () => {
    const { gearChatArgs } = require('../../../chatRunner.cjs');
    const { args, errors } = gearChatArgs({
      snapshot,
      deps: {
        knownMcpServers: known,
        listPacks: () => ({ packs: [{ id: 'session-manager-dev', skills: [] }] }),
        listUnpackedSkills: () => [],
      },
    });
    assert.ok(scopedTools(args).includes('mcp__session-manager-scheduler'));
    const cfg = jsonAfter(args, '--mcp-config');
    assert.ok(cfg && cfg.mcpServers['session-manager-scheduler']);
    assert.deepEqual(errors, []);
  });

  it('personaToolScopeArgs: no refusal, scheduler server in tools', () => {
    const r = personaToolScopeArgs(buildPersonaToolScope(tools, { loadout: 'equipped', disallowed: [] }), {
      mcpServers: known,
      declaredServers: ['session-manager-scheduler'],
    });
    assert.equal(r.refusal, null);
    assert.ok(scopedTools(r.args).includes('mcp__session-manager-scheduler'));
  });
});
