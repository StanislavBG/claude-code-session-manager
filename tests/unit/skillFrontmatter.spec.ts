/**
 * Skill enable/disable frontmatter mutation.
 *
 * The Skills tab toggles `disable-model-invocation` in SKILL.md to turn a skill
 * off — the real CLI flag. A regression here either fails to disable a skill or
 * corrupts the surrounding frontmatter, so this locks in the surgical-edit
 * invariant: only the one key line is touched; everything else round-trips.
 *
 * Source: src/renderer/lib/skillFrontmatter.ts.
 */
import { describe, it, expect } from 'vitest'
import { readSkillDisabled, setSkillDisabled, parseSkillMeta } from '../../src/renderer/lib/skillFrontmatter'

const SKILL = `---
name: my-skill
description: does a thing
allowed-tools: Read, Grep
---

# My Skill

Body stays put.
`

describe('readSkillDisabled', () => {
  it('is false when the key is absent', () => {
    expect(readSkillDisabled(SKILL)).toBe(false)
  })
  it('is true only when explicitly enabled', () => {
    expect(readSkillDisabled(SKILL.replace('name: my-skill', 'name: my-skill\ndisable-model-invocation: true'))).toBe(true)
    expect(readSkillDisabled(SKILL.replace('name: my-skill', 'name: my-skill\ndisable-model-invocation: false'))).toBe(false)
  })
  it('is false when there is no frontmatter', () => {
    expect(readSkillDisabled('# Just a body')).toBe(false)
  })
})

describe('setSkillDisabled', () => {
  it('adds the flag, preserving every other line', () => {
    const out = setSkillDisabled(SKILL, true)
    expect(readSkillDisabled(out)).toBe(true)
    expect(out).toContain('name: my-skill')
    expect(out).toContain('description: does a thing')
    expect(out).toContain('allowed-tools: Read, Grep')
    expect(out).toContain('Body stays put.')
  })

  it('removes the flag when re-enabled (absence = default on)', () => {
    const disabled = setSkillDisabled(SKILL, true)
    const reenabled = setSkillDisabled(disabled, false)
    expect(readSkillDisabled(reenabled)).toBe(false)
    expect(reenabled).not.toContain('disable-model-invocation')
    expect(reenabled).toContain('allowed-tools: Read, Grep')
  })

  it('is a no-op when already in the requested state', () => {
    expect(setSkillDisabled(SKILL, false)).toBe(SKILL)
    const disabled = setSkillDisabled(SKILL, true)
    expect(setSkillDisabled(disabled, true)).toBe(disabled)
  })

  it('synthesizes frontmatter when none exists and disabling', () => {
    const out = setSkillDisabled('# Bare body', true)
    expect(out.startsWith('---\ndisable-model-invocation: true\n---\n')).toBe(true)
    expect(readSkillDisabled(out)).toBe(true)
    expect(out).toContain('# Bare body')
  })

  it('toggles an existing false flag to true in place', () => {
    const withFalse = SKILL.replace('name: my-skill', 'name: my-skill\ndisable-model-invocation: false')
    const out = setSkillDisabled(withFalse, true)
    expect(readSkillDisabled(out)).toBe(true)
    // Only one occurrence — replaced in place, not appended.
    expect(out.match(/disable-model-invocation/g)?.length).toBe(1)
  })
})

describe('parseSkillMeta', () => {
  it('parses name/description from a simple flat frontmatter block', () => {
    const meta = parseSkillMeta(SKILL)
    expect(meta.name).toBe('my-skill')
    expect(meta.description).toBe('does a thing')
  })

  it('returns nulls for a bare body with no frontmatter', () => {
    const meta = parseSkillMeta('# Just a body')
    expect(meta).toEqual({ name: null, description: null, body: '# Just a body' })
  })

  it('folds a multi-line description: >- block into one space-joined string', () => {
    const folded = `---
name: folded-skill
description: >-
  first line of the description
  second line continues it
allowed-tools: Read
---

# Folded Skill
`
    const meta = parseSkillMeta(folded)
    expect(meta.name).toBe('folded-skill')
    expect(meta.description).toBe('first line of the description second line continues it')
  })

  it('never includes the frontmatter block in body', () => {
    const meta = parseSkillMeta(SKILL)
    expect(meta.body).not.toContain('name: my-skill')
    expect(meta.body).not.toContain('description: does a thing')
    expect(meta.body).toContain('Body stays put.')
  })
})
