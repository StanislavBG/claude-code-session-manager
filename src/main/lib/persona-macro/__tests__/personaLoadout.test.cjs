'use strict';

// Run: timeout 120 npx vitest run src/main/lib/persona-macro/__tests__/personaLoadout.test.cjs

const assert = require('node:assert/strict');
const { loadoutState, encodeLoadout } = require('../personaLoadout.cjs');
const { serializePersona, parseTools } = require('../../../agentLibrary.cjs');
const { splitFrontmatter } = require('../../prd/prdFrontmatter.cjs');
const { validatePersonaFrontmatter } = require('../personaFrontmatterSchema.cjs');

describe('loadoutState', () => {
  it('classifies all four states', () => {
    assert.equal(loadoutState({}), 'undecided');
    assert.equal(loadoutState({ tools: '' }), 'undecided');
    assert.equal(loadoutState({ tools: 'none' }), 'bare');
    assert.equal(loadoutState({ tools: 'Read, Bash' }), 'equipped');
    assert.equal(loadoutState({ tools: '*' }), 'unbound');
    assert.equal(loadoutState({ tools: ['*'] }), 'unbound');
  });
});

describe('encodeLoadout', () => {
  it('encodes each state', () => {
    assert.equal(encodeLoadout('undecided', ['Read']), null);
    assert.equal(encodeLoadout('bare', ['Read']), 'none');
    assert.equal(encodeLoadout('unbound', []), '*');
    assert.equal(encodeLoadout('equipped', ['Read', 'Bash']), 'Read, Bash');
  });
});

describe('round-trip through serializePersona', () => {
  for (const [state, tools] of [['undecided', []], ['bare', []], ['equipped', ['Read', 'Grep']], ['unbound', []]]) {
    it(state, () => {
      const text = serializePersona({ name: 'x', description: 'd', loadout: state, tools, model: 'opus', body: 'B' });
      const { fm } = splitFrontmatter(text);
      assert.equal(loadoutState(fm), state);
      assert.equal(validatePersonaFrontmatter(fm).ok, true);
      if (state === 'equipped') assert.deepEqual(parseTools(fm.tools), tools);
    });
  }

  it('rejects none mixed with other tools', () => {
    assert.equal(validatePersonaFrontmatter({ name: 'x', model: 'opus', tools: 'none, Read' }).ok, false);
  });
});
