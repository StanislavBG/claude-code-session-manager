'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/personaToolScopeMcpConfig.test.cjs

const assert = require('node:assert/strict');
const { personaToolScopeArgs } = require('../personaToolScope.cjs');
const { buildClaudeSpawnArgs } = require('../../../scheduler.cjs');
const { SERVER_NAME, schedulerServerEntry } = require('../../../seedSchedulerMcp.cjs');

const entry = { command: 'node', args: ['/x/server.cjs'] };
const tool = `mcp__${SERVER_NAME}__scheduler_create_prd`;

describe('personaToolScopeArgs mcpServers', () => {
  it('passes only the named known servers', () => {
    const scope = { tools: ['Read', tool, 'Skill'] };
    const args = personaToolScopeArgs(scope, { mcpServers: { [SERVER_NAME]: entry, other: entry } });
    const i = args.indexOf('--mcp-config');
    assert.ok(i >= 0);
    assert.deepEqual(JSON.parse(args[i + 1]), { mcpServers: { [SERVER_NAME]: entry } });
    assert.equal(args[i + 2], '--strict-mcp-config');
  });

  it('falls back to today\'s output when a named server is unknown', () => {
    const scope = { tools: [tool, 'mcp__unknown__t'] };
    const args = personaToolScopeArgs(scope, { mcpServers: { [SERVER_NAME]: entry } });
    assert.deepEqual(args, personaToolScopeArgs(scope));
    assert.ok(!args.includes('--mcp-config') && !args.includes('--strict-mcp-config'));
  });

  it('no mcp tool -> only --strict-mcp-config; null scope -> []', () => {
    const args = personaToolScopeArgs({ tools: ['Read'] }, { mcpServers: { [SERVER_NAME]: entry } });
    assert.ok(args.includes('--strict-mcp-config') && !args.includes('--mcp-config'));
    assert.deepEqual(personaToolScopeArgs(null, { mcpServers: {} }), []);
  });
});

describe('seedSchedulerMcp.schedulerServerEntry', () => {
  it('returns the command/args the seed registers', () => {
    const e = schedulerServerEntry('/s.cjs');
    assert.equal(typeof e.command, 'string');
    assert.deepEqual(e.args, ['/s.cjs']);
  });
});

describe('buildClaudeSpawnArgs mcp-config ordering', () => {
  it('element after the --mcp-config value starts with --', () => {
    const argv = buildClaudeSpawnArgs({
      model: 'm', sessionId: 's', toolScope: { tools: [tool, 'Skill'] },
    });
    const i = argv.indexOf('--mcp-config');
    assert.ok(i >= 0);
    const cfg = JSON.parse(argv[i + 1]);
    assert.deepEqual(Object.keys(cfg.mcpServers), [SERVER_NAME]);
    assert.ok(argv[i + 2].startsWith('--'));
    assert.equal(argv[i + 2], '--strict-mcp-config');
    assert.ok(argv[i + 3].startsWith('--'));
  });
});
