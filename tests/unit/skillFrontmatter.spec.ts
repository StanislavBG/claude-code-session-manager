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
import { readSkillDisabled, setSkillDisabled } from '../../src/renderer/lib/skillFrontmatter'

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
