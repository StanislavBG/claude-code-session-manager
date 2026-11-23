'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/personaDeclaredCapabilities.test.cjs
//
// Persona frontmatter declares `mcpServers:` / `packs:` (string lists); the
// schema admits them, MANAGED_PERSONA_KEYS lists them, and a save from the
// Agent Library form (which has no field for them) keeps the file's values.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePersonaFrontmatter } = require('../../persona-macro/personaFrontmatterSchema.cjs');
const { MANAGED_PERSONA_KEYS, parseCapabilityList, savePersona } = require('../../../agentLibrary.cjs');
const { splitFrontmatter } = require('../../prd/prdFrontmatter.cjs');

const base = { name: 'x', description: 'd', model: 'sonnet' };

describe('persona declared capabilities', () => {
  it('MANAGED_PERSONA_KEYS includes mcpServers and packs', () => {
    expect(MANAGED_PERSONA_KEYS.has('mcpServers')).toBe(true);
    expect(MANAGED_PERSONA_KEYS.has('packs')).toBe(true);
  });

  it('schema accepts string lists and comma strings', () => {
    expect(validatePersonaFrontmatter({ ...base, mcpServers: ['a', 'b'], packs: ['web'] })).toEqual({ ok: true });
    expect(validatePersonaFrontmatter({ ...base, mcpServers: 'a, b', packs: 'web' })).toEqual({ ok: true });
  });

  it('schema rejects non-list values and blank entries', () => {
    for (const bad of [{ mcpServers: 3 }, { packs: true }, { mcpServers: [''] }, { packs: '  ' }]) {
      const r = validatePersonaFrontmatter({ ...base, ...bad });
      expect(r.ok).toBe(false);
    }
  });

  it('parseCapabilityList trims, dedupes and drops junk', () => {
    expect(parseCapabilityList(' a, b ,a,, ')).toEqual(['a', 'b']);
    expect(parseCapabilityList(['x', 1, ' y '])).toEqual(['x', 'y']);
    expect(parseCapabilityList(undefined)).toEqual([]);
  });

  it('savePersona writes declared capabilities and carries them over when omitted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cap-persona-'));
    try {
      const opts = {
        globalDir: dir,
        validatePath: (p) => p,
        writeTextAtomic: async (p, t) => fs.writeFileSync(p, t),
      };
      await savePersona({ ...opts, name: 'cap-p', description: 'd', model: 'sonnet', body: 'b', mcpServers: ['session-manager-scheduler'], packs: ['web'] });
      const file = path.join(dir, 'cap-p.md');
      let fm = splitFrontmatter(fs.readFileSync(file, 'utf8')).fm;
      expect(parseCapabilityList(fm.mcpServers)).toEqual(['session-manager-scheduler']);
      expect(parseCapabilityList(fm.packs)).toEqual(['web']);
      await savePersona({ ...opts, name: 'cap-p', description: 'd2', model: 'sonnet', body: 'b2' });
      fm = splitFrontmatter(fs.readFileSync(file, 'utf8')).fm;
      expect(fm.description).toBe('d2');
      expect(parseCapabilityList(fm.mcpServers)).toEqual(['session-manager-scheduler']);
      expect(parseCapabilityList(fm.packs)).toEqual(['web']);
      expect(validatePersonaFrontmatter(fm)).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
