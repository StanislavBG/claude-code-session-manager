'use strict';

// Run: timeout 120 npx vitest run src/main/lib/persona-macro/__tests__/personaLoadout.test.cjs

const assert = require('node:assert/strict');
const { loadoutState, encodeLoadout, BARE_ENCODING, UNBOUND_TOOL } = require('../personaLoadout.cjs');
const { serializePersona, parseTools } = require('../../../agentLibrary.cjs');
const { splitFrontmatter } = require('../../prd/prdFrontmatter.cjs');
const { validatePersonaFrontmatter } = require('../personaFrontmatterSchema.cjs');

describe('loadoutState', () => {
  it('classifies all four states', () => {
    assert.equal(loadoutState({}), 'undecided');
    assert.equal(loadoutState(null), 'undecided');
    assert.equal(loadoutState({ tools: undefined }), 'undecided');
    assert.equal(loadoutState({ tools: '' }), 'bare');
    assert.equal(loadoutState({ tools: null }), 'bare');
    assert.equal(loadoutState({ tools: '   ' }), 'bare');
    assert.equal(loadoutState({ tools: '[]' }), 'bare');
    assert.equal(loadoutState({ tools: [] }), 'bare');
    assert.equal(loadoutState({ tools: 'Read, Bash' }), 'equipped');
    assert.equal(loadoutState({ tools: '*' }), 'unbound');
    assert.equal(loadoutState({ tools: ['*'] }), 'unbound');
  });
});

describe('constants', () => {
  it('exports the encodings', () => {
    assert.equal(BARE_ENCODING, '[]');
    assert.equal(UNBOUND_TOOL, '*');
  });
});

describe('encodeLoadout', () => {
  it('encodes each state', () => {
    assert.equal(encodeLoadout('undecided', ['Read']), null);
    assert.equal(encodeLoadout('bare', ['Read']), '[]');
    assert.equal(encodeLoadout('unbound', []), '*');
    assert.equal(encodeLoadout('equipped', ['Read', 'Bash']), 'Read, Bash');
    assert.equal(encodeLoadout('equipped', []), null);
  });
});

describe('round-trip through serializePersona', () => {
  for (const [state, tools] of [['undecided', []], ['bare', []], ['equipped', ['Read', 'Grep']], ['unbound', []]]) {
    it(state, () => {
      const text = serializePersona({ name: 'x', description: 'd', loadout: state, tools, model: 'opus', body: 'B' });
      const { fm } = splitFrontmatter(text);
      assert.equal(loadoutState(fm), state);
      assert.equal(validatePersonaFrontmatter(fm).ok, true);
      if (state === 'bare') assert.match(text, /^tools: \[\]$/m);
      if (state === 'undecided') assert.equal('tools' in fm, false);
      if (state === 'equipped') assert.deepEqual(parseTools(fm.tools), tools);
    });
  }

  it('accepts [] / empty / * and rejects * mixed with other tools', () => {
    for (const tools of ['[]', '', '*']) assert.equal(validatePersonaFrontmatter({ name: 'x', model: 'opus', tools }).ok, true);
    assert.equal(validatePersonaFrontmatter({ name: 'x', model: 'opus', tools: '*, Read' }).ok, false);
  });
});
