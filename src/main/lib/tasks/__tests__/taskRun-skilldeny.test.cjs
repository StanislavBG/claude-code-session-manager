'use strict';

import { test, expect } from 'vitest';
const { buildTaskArgs } = require('../taskRun.cjs');
const { resolveSkillDeny } = require('../../claude/personaToolScope.cjs');

const deps = {
  listPacks: () => ({ packs: [{ id: 'dev', skills: ['session-manager-dev:develop'] }, { id: 'other', skills: ['other:x'] }] }),
  listUnpackedSkills: () => ['loose'],
  getBuiltinTools: async () => ({ tools: [], skills: ['init'] }),
};

test('a persona carrying the dev pack is not denied develop; one without is', async () => {
  const withPack = await resolveSkillDeny({ packs: ['dev'], loadout: 'equipped', deps });
  expect(withPack.args).not.toContain('--disallowedTools=Skill(session-manager-dev:develop)');
  expect(withPack.args).toContain('--disallowedTools=Skill(other:x)');
  const without = await resolveSkillDeny({ packs: [], loadout: 'equipped', deps });
  expect(without.args).toContain('--disallowedTools=Skill(session-manager-dev:develop)');
  expect(without.denied).toBe(3);
  expect(without.args).not.toContain('--disallowedTools=Skill(init)');
});

test('buildTaskArgs appends the skill deny args', async () => {
  const { args } = await resolveSkillDeny({ packs: [], loadout: 'equipped', deps });
  const out = buildTaskArgs({ model: 'm', effort: 'low', skillDeny: args });
  expect(out).toContain('--disallowedTools=Skill(session-manager-dev:develop)');
  expect(buildTaskArgs({ model: 'm', effort: 'low' }).some((a) => a.includes('Skill('))).toBe(false);
});
