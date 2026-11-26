'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/personaToolScope.test.cjs

const assert = require('node:assert/strict');
const {
  HEADLESS_TOOL_FLOOR,
  HEADLESS_SCOPE_AGENT_NAME,
  buildPersonaToolScope,
  personaToolScopeArgs,
  personaToolScopeEnv,
  JOB_MCP_TOOLS_ENV,
} = require('../personaToolScope.cjs');

describe('personaToolScopeEnv', () => {
  it('names the env var', () => {
    assert.equal(JOB_MCP_TOOLS_ENV, 'SM_SCHEDULER_JOB_MCP_TOOLS');
  });

  it('returns {} for an unscoped job', () => {
    assert.deepEqual(personaToolScopeEnv(null), {});
  });

  it("returns '[]' when the scope names no MCP tool", () => {
    assert.deepEqual(personaToolScopeEnv({ tools: ['Read', 'Bash', 'Agent'] }), {
      SM_SCHEDULER_JOB_MCP_TOOLS: '[]',
    });
  });

  it('returns every mcp__ entry in scope order, nothing else', () => {
    const t = 'mcp__session-manager-scheduler__project_demo_video_write';
    assert.deepEqual(personaToolScopeEnv({ tools: ['Read', t, 'Agent'] }), {
      SM_SCHEDULER_JOB_MCP_TOOLS: JSON.stringify([t]),
    });
  });
});

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
    assert.deepEqual(personaToolScopeArgs(null), { args: ['--strict-mcp-config'], refusal: null });
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

  it('appends StructuredOutput when structuredOutput is true', () => {
    const scope = buildPersonaToolScope(['Read', 'Bash'], { structuredOutput: true });
    assert.deepEqual(scope.tools, ['Read', 'Bash', 'Agent', 'Skill', 'ToolSearch', 'TodoWrite', 'StructuredOutput']);
    const twice = buildPersonaToolScope(['StructuredOutput', 'Read'], { structuredOutput: true });
    assert.equal(twice.tools.filter((t) => t === 'StructuredOutput').length, 1);
  });

  it('does not add StructuredOutput when absent/false or disallowed', () => {
    assert.ok(!buildPersonaToolScope(['Read']).tools.includes('StructuredOutput'));
    assert.ok(!buildPersonaToolScope(['Read'], { structuredOutput: false }).tools.includes('StructuredOutput'));
    const blocked = buildPersonaToolScope(['Read'], { structuredOutput: true, disallowed: ['StructuredOutput'] });
    assert.ok(!blocked.tools.includes('StructuredOutput'));
  });

  it('keeps an unscoped (null) scope null even with structuredOutput', () => {
    for (const t of [null, undefined, [], ['*']]) {
      assert.equal(buildPersonaToolScope(t, { structuredOutput: true }), null);
    }
  });

  it('builds --agents JSON that parses back', () => {
    const scope = buildPersonaToolScope(['Read']);
    const { args } = personaToolScopeArgs(scope);
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
    const { args } = personaToolScopeArgs(buildPersonaToolScope(['Read', 'Bash']));
    assert.equal(args[args.length - 1], '--strict-mcp-config');
    assert.ok(!args.includes('--mcp-config'));
  });

  it('an unknown mcp__ server is refused and never drops --strict-mcp-config', () => {
    const { args, refusal } = personaToolScopeArgs(buildPersonaToolScope(['Read', 'mcp__blender']));
    assert.deepEqual(refusal, { code: 'capability_unknown', name: 'blender' });
    assert.equal(args[args.length - 1], '--strict-mcp-config');
    assert.ok(!args.includes('--mcp-config'));
  });
});

describe('seed personas that save through an MCP tool', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { splitFrontmatter } = require('../../prd/prdFrontmatter.cjs');
  const cases = [
    ['demo-video-builder', 'mcp__session-manager-scheduler__project_demo_video_write'],
    ['project-home-builder', 'mcp__session-manager-scheduler__project_home_write'],
  ];
  for (const [name, tool] of cases) {
    it(`${name} scope contains its save tool and boots MCP`, () => {
      const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'seed', 'agents', `${name}.md`), 'utf8');
      const tools = splitFrontmatter(raw).fm.tools.split(',').map((t) => t.trim());
      const scope = buildPersonaToolScope(tools);
      assert.ok(scope.tools.includes(tool));
      const { SERVER_NAME } = require('../../../seedSchedulerMcp.cjs');
      const entry = { command: 'node', args: ['/x.cjs'] };
      const { args, refusal } = personaToolScopeArgs(scope, { mcpServers: { [SERVER_NAME]: entry } });
      assert.equal(refusal, null);
      const i = args.indexOf('--mcp-config');
      assert.deepEqual(Object.keys(JSON.parse(args[i + 1]).mcpServers), [SERVER_NAME]);
      assert.equal(args[i + 2], '--strict-mcp-config');
    });
  }
});

describe('loadout states', () => {
  it('Bare ({ loadout: bare }) is floor-only, even with an empty list', () => {
    const scope = buildPersonaToolScope([], { loadout: 'bare' });
    assert.deepEqual(scope.tools, [...HEADLESS_TOOL_FLOOR]);
  });

  it('Unbound and Undecided are unscoped', () => {
    assert.equal(buildPersonaToolScope([], { loadout: 'unbound' }), null);
    assert.equal(buildPersonaToolScope(['Read'], { loadout: 'undecided' }), null);
  });

  it('Unbound (tools: *) is unscoped', () => {
    assert.equal(buildPersonaToolScope(['*']), null);
  });
});
