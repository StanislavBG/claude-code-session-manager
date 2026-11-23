// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
import { describe, it, expect } from 'vitest';
const { validatePersonaFrontmatter } = require('../personaFrontmatterSchema.cjs');
const { splitFrontmatter } = require('../../prd/prdFrontmatter.cjs');
const { MANAGED_PERSONA_KEYS } = require('../../../agentLibrary.cjs');

const SEED_DIR = path.resolve(__dirname, '../../../../seed/agents');

/** @param {string} file */
function seedFm(file) {
  return splitFrontmatter(fs.readFileSync(path.join(SEED_DIR, file), 'utf8')).fm;
}

describe('validatePersonaFrontmatter', () => {
  it('accepts a valid seed persona (dev-lead)', () => {
    expect(validatePersonaFrontmatter(seedFm('dev-lead.md'))).toEqual({ ok: true });
  });

  it('rejects an unknown key and names it', () => {
    const r = validatePersonaFrontmatter({ ...seedFm('dev-lead.md'), bogusKey: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('bogusKey'))).toBe(true);
  });

  it('rejects a persona with no model and names `model`', () => {
    const { model: _drop, ...fm } = seedFm('dev-lead.md');
    const r = validatePersonaFrontmatter(fm);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('model'))).toBe(true);
  });

  it('rejects `model: inherit` and names `model`', () => {
    const r = validatePersonaFrontmatter({ ...seedFm('dev-lead.md'), model: 'inherit' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('model'))).toBe(true);
  });

  it('rejects an empty model', () => {
    const r = validatePersonaFrontmatter({ ...seedFm('dev-lead.md'), model: '  ' });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(validatePersonaFrontmatter(null).ok).toBe(false);
  });

  it('accepts every managed key', () => {
    /** @type {Record<string, string>} */
    const fm = {};
    for (const k of MANAGED_PERSONA_KEYS) fm[k] = 'x';
    fm.model = 'opus';
    expect(validatePersonaFrontmatter(fm)).toEqual({ ok: true });
  });

  const seeds = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.md'));
  it('finds seed personas', () => {
    expect(seeds.length).toBeGreaterThan(0);
  });
  for (const file of seeds) {
    it(`seed ${file} passes`, () => {
      expect(validatePersonaFrontmatter(seedFm(file))).toEqual({ ok: true });
    });
  }
});
