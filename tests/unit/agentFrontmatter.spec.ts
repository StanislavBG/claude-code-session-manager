/**
 * Subagent frontmatter parse/serialize round-trip.
 *
 * The Subagents tab writes back to disk; any serializer regression silently
 * corrupts user subagent files. This spec locks in round-trip for the
 * canonical fixtures and asserts unknown keys survive verbatim.
 *
 * Note: agentFrontmatter.ts strips one leading body newline on serialize
 * (matching the regex's optional trailing newline consume), so test fixtures
 * stick to bodies that begin with a non-newline character.
 *
 * Source: src/renderer/lib/agentFrontmatter.ts.
 */
import { describe, it, expect } from 'vitest'
import { parseAgentFile, serializeAgentFile } from '../../src/renderer/lib/agentFrontmatter'

describe('agentFrontmatter round-trip', () => {
  const cases = [
    {
      name: 'minimal name only',
      text: '---\nname: foo\n---\nbody\n',
    },
    {
      name: 'with inline tools array',
      text: '---\nname: foo\ntools: [Read, Write]\n---\nbody\n',
    },
    {
      name: 'with model + maxTurns',
      text: '---\nname: foo\nmodel: opus\nmaxTurns: 5\n---\nbody\n',
    },
  ]

  for (const c of cases) {
    it(`${c.name} round-trips byte-identical`, () => {
      const parsed = parseAgentFile(c.text)
      const out = serializeAgentFile(parsed.frontmatter, parsed.body)
      expect(out).toBe(c.text)
    })
  }

  it('preserves unknown frontmatter keys in extras', () => {
    const text = '---\nname: foo\nweirdKey: weirdValue\nanother: thing\n---\nbody\n'
    const parsed = parseAgentFile(text)
    expect(parsed.frontmatter.extras?.weirdKey).toBeDefined()
    expect(parsed.frontmatter.extras?.weirdKey.lines).toEqual(['weirdKey: weirdValue'])
    expect(parsed.frontmatter.extras?.another).toBeDefined()
    // Round-trip through serialize: unknown keys re-emit from their band
    // verbatim, so the output still contains both lines (order may differ
    // because recognized keys emit first).
    const out = serializeAgentFile(parsed.frontmatter, parsed.body)
    expect(out).toContain('weirdKey: weirdValue')
    expect(out).toContain('another: thing')
  })

  it('parses multi-paragraph body verbatim', () => {
    // The parser consumes exactly one `\n` after the closing `---`, so a
    // body that starts with a printable character round-trips cleanly.
    const text = '---\nname: foo\n---\nparagraph one.\n\nparagraph two.\n\nparagraph three.\n'
    const parsed = parseAgentFile(text)
    expect(parsed.body).toBe('paragraph one.\n\nparagraph two.\n\nparagraph three.\n')
    const out = serializeAgentFile(parsed.frontmatter, parsed.body)
    expect(out).toBe(text)
  })

  it('parses inline tools as string[]', () => {
    const { frontmatter } = parseAgentFile('---\nname: x\ntools: [Read, Write, Bash]\n---\nx\n')
    expect(frontmatter.tools).toEqual(['Read', 'Write', 'Bash'])
  })
})
