import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyToolUse } = require('../../src/main/lib/toolUseClassify.cjs') as {
  classifyToolUse: (block: { name: string; input?: Record<string, unknown> }) => {
    kind: 'skill' | 'mcp' | 'tool';
    label: string;
  };
};

describe('classifyToolUse', () => {
  it('classifies a Skill block by its input.skill', () => {
    expect(
      classifyToolUse({ name: 'Skill', input: { skill: 'code-review', args: '--fix' } }),
    ).toEqual({ kind: 'skill', label: 'code-review' });
  });

  it('falls back to label "skill" when a Skill block has no input.skill', () => {
    expect(classifyToolUse({ name: 'Skill', input: {} })).toEqual({
      kind: 'skill',
      label: 'skill',
    });
    expect(classifyToolUse({ name: 'Skill' })).toEqual({ kind: 'skill', label: 'skill' });
  });

  it('classifies an mcp__ prefixed tool, stripping the prefix', () => {
    expect(classifyToolUse({ name: 'mcp__sqlite__query', input: {} })).toEqual({
      kind: 'mcp',
      label: 'sqlite__query',
    });
  });

  it('classifies a plain built-in tool by its name', () => {
    expect(classifyToolUse({ name: 'Bash', input: { command: 'ls' } })).toEqual({
      kind: 'tool',
      label: 'Bash',
    });
  });
});
