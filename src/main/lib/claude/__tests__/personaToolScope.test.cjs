'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/personaToolScope.test.cjs

const assert = require('node:assert/strict');
const {
  HEADLESS_TOOL_FLOOR,
  HEADLESS_SCOPE_AGENT_NAME,
  buildPersonaToolScope,
  personaToolScopeArgs,
} = require('../personaToolScope.cjs');

describe('personaToolScope', () => {
  it('exports the frozen floor and agent name', () => {
    assert.deepEqual([...HEADLESS_TOOL_FLOOR], ['Agent', 'Skill', 'ToolSearch', 'TodoWrite']);
    assert.ok(Object.isFrozen(HEADLESS_TOOL_FLOOR));
    assert.equal(HEADLESS_SCOPE_AGENT_NAME, 'sm-headless-scoped');
  });

  it('returns null / [] when the persona declares no restriction', () => {
    for (const t of [null, undefined, [], ['*'], ['Read', '*']]) {
      assert.equal(buildPersonaToolScope(t), null);
    }
    assert.deepEqual(personaToolScopeArgs(null), []);
  });

  it('passes MCP names through and appends the floor once', () => {
    const tools = ['Read', 'mcp__blender__execute_blender_code_for_cli', 'mcp__blender'];
    assert.deepEqual(buildPersonaToolScope(tools).tools, [
      ...tools, 'Agent', 'Skill', 'ToolSearch', 'TodoWrite',
    ]);
  });

  it('does not duplicate floor entries or repeated names', () => {
    const scope = buildPersonaToolScope(['Skill', 'Read', 'Read', 'Agent']);
    assert.deepEqual(scope.tools, ['Skill', 'Read', 'Agent', 'ToolSearch', 'TodoWrite']);
  });

  it('trims names and drops blanks', () => {
    const scope = buildPersonaToolScope(['  Read ', '', '   ', 'Bash']);
    assert.deepEqual(scope.tools, ['Read', 'Bash', 'Agent', 'Skill', 'ToolSearch', 'TodoWrite']);
  });

  it('removes disallowed names', () => {
    const scope = buildPersonaToolScope(['Read', 'Monitor', 'AskUserQuestion'], {
      disallowed: ['Monitor', 'AskUserQuestion'],
    });
    assert.deepEqual(scope.tools, ['Read', 'Agent', 'Skill', 'ToolSearch', 'TodoWrite']);
  });

  it('builds --agents JSON that parses back', () => {
    const scope = buildPersonaToolScope(['Read']);
    const args = personaToolScopeArgs(scope);
    assert.equal(args.length, 5);
    assert.equal(args[0], '--agents');
    assert.equal(args[2], '--agent');
    assert.equal(args[3], HEADLESS_SCOPE_AGENT_NAME);
    const parsed = JSON.parse(args[1]);
    assert.deepEqual(Object.keys(parsed), [HEADLESS_SCOPE_AGENT_NAME]);
    const def = parsed[HEADLESS_SCOPE_AGENT_NAME];
    assert.equal(typeof def.description, 'string');
    assert.match(def.prompt, /scheduler/);
    assert.deepEqual(def.tools, scope.tools);
  });

  it('adds --strict-mcp-config when scope names no mcp__ tool', () => {
    const args = personaToolScopeArgs(buildPersonaToolScope(['Read', 'Bash']));
    assert.equal(args[args.length - 1], '--strict-mcp-config');
    assert.ok(!args.includes('--mcp-config'));
  });

  it('omits --strict-mcp-config when scope names an mcp__ tool', () => {
    const args = personaToolScopeArgs(buildPersonaToolScope(['Read', 'mcp__blender']));
    assert.equal(args.length, 4);
    assert.ok(!args.includes('--strict-mcp-config'));
    assert.ok(!args.includes('--mcp-config'));
  });
});
