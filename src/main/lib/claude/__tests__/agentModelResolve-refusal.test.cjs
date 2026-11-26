'use strict';
// resolvePrdPersonaForSpawn refuses instead of falling back to
// "no persona + sonnet": a missing persona → persona_missing, a frontmatter
// that fails validatePersonaFrontmatter → persona_invalid. scheduler.cjs
// parks the job needs_review on either.
import { describe, it, expect } from 'vitest';
const { resolvePrdPersonaForSpawn } = require('../agentModelResolve.cjs');

const noLog = () => {};

describe('resolvePrdPersonaForSpawn refusal', () => {
  it('refuses with persona_missing when the agentType resolves to no persona file', async () => {
    const reported = [];
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: 'ghost-persona',
      deps: { getPersonaBody: async () => null, reportDanglingAgentTypeOnce: (cwd, name) => reported.push([cwd, name]) },
    });
    expect(r.refusal).toEqual({ code: 'persona_missing', detail: expect.stringContaining("'ghost-persona'") });
    expect(r.model).toBeNull();
    expect(r.systemPrompt).toBeNull();
    expect(reported).toEqual([['/tmp/proj', 'ghost-persona']]);
  });

  it('refuses with persona_missing when the persona read throws (unreadable)', async () => {
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: 'dev-lead',
      deps: { getPersonaBody: async () => { throw new Error('EACCES'); }, reportDanglingAgentTypeOnce: noLog },
    });
    expect(r.refusal.code).toBe('persona_missing');
    expect(r.refusal.detail).toContain('EACCES');
  });

  it('refuses with persona_invalid when the frontmatter has no model', async () => {
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: 'builder',
      deps: { getPersonaBody: async () => ({ path: '/x/builder.md', text: '---\nname: builder\ntools: Read\n---\nBody.' }) },
    });
    expect(r.refusal.code).toBe('persona_invalid');
    expect(r.refusal.detail).toContain('model');
    expect(r.refusal.detail).toContain('/x/builder.md');
    expect(r.model).toBeNull();
    expect(r.personaPath).toBe('/x/builder.md');
  });

  it("refuses with persona_invalid when model is 'inherit'", async () => {
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: 'dev-lead',
      deps: { getPersonaBody: async () => ({ path: '/x/dev-lead.md', text: '---\nmodel: inherit\n---\nBody.' }) },
    });
    expect(r.refusal.code).toBe('persona_invalid');
  });

  it('refuses with persona_invalid on an unknown frontmatter key', async () => {
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: 'dev-lead',
      deps: { getPersonaBody: async () => ({ path: '/x/dev-lead.md', text: '---\nmodel: opus\nbogus: 1\n---\nBody.' }) },
    });
    expect(r.refusal.code).toBe('persona_invalid');
    expect(r.refusal.detail).toContain('bogus');
  });

  it("resolves a null agentType as 'dev-lead'", async () => {
    const names = [];
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: null,
      deps: { getPersonaBody: async ({ name }) => { names.push(name); return { path: '/x/dev-lead.md', text: '---\nmodel: opus\n---\nLead.' }; } },
    });
    expect(names).toEqual(['dev-lead']);
    expect(r.refusal).toBeNull();
    expect(r.model).toBe('opus');
    expect(r.systemPrompt).toBe('Lead.');
  });

  it('a null agentType with no dev-lead persona is refused, not spawned on a fallback', async () => {
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: null,
      deps: { getPersonaBody: async () => null, reportDanglingAgentTypeOnce: noLog },
    });
    expect(r.refusal.code).toBe('persona_missing');
    expect(r.refusal.detail).toContain("'dev-lead'");
  });

  it('a valid persona returns no refusal, its model, body, path and tools', async () => {
    const r = await resolvePrdPersonaForSpawn({
      cwd: '/tmp/proj',
      agentType: 'validator',
      deps: { getPersonaBody: async () => ({ path: '/x/validator.md', text: '---\nname: validator\nmodel: opus\ntools: Read, Grep\n---\nValidate.' }) },
    });
    expect(r).toEqual({ model: 'opus', systemPrompt: 'Validate.', personaPath: '/x/validator.md', tools: ['Read', 'Grep'], loadout: 'equipped', refusal: null });
  });
});
