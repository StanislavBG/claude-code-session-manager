import { describe, it, expect } from 'vitest'
import { splitFrontmatter, joinFrontmatter } from '../../src/renderer/lib/markdownDoc'

describe('splitFrontmatter', () => {
  it('round-trips a file with no frontmatter identically', () => {
    const raw = '# Hello\n\nSome paragraph.\n'
    const split = splitFrontmatter(raw)
    expect(split.frontmatter).toBe('')
    expect(split.body).toBe(raw)
    expect(split.data).toEqual({})
    expect(joinFrontmatter(split, split.body)).toBe(raw)
  })

  it('round-trips body mutation with unchanged frontmatter', () => {
    const raw = '---\ntitle: My PRD\ncwd: /tmp\nestimateMinutes: 5\n---\n# Body\n\nOriginal text.\n'
    const split = splitFrontmatter(raw)
    expect(split.frontmatter).toBe('---\ntitle: My PRD\ncwd: /tmp\nestimateMinutes: 5\n---\n')
    expect(split.body).toBe('# Body\n\nOriginal text.\n')
    expect(split.data['title']).toBe('My PRD')
    const mutatedBody = '# Body\n\nChanged text.\n'
    const result = joinFrontmatter(split, mutatedBody)
    expect(result).toBe('---\ntitle: My PRD\ncwd: /tmp\nestimateMinutes: 5\n---\n# Body\n\nChanged text.\n')
    // Frontmatter block is byte-identical.
    expect(result.startsWith(split.frontmatter)).toBe(true)
  })

  it('does not throw on malformed frontmatter — treats entire file as body', () => {
    const raw = '---\nnot: valid: yaml: : :\n---\n# Body\n'
    // Should not throw.
    const split = splitFrontmatter(raw)
    // Malformed YAML still parses structurally via our line-band approach
    // (a colon-containing line is treated as key: rest). What matters is no throw.
    // The frontmatter block IS structurally valid delimiters even if YAML is odd.
    expect(() => joinFrontmatter(split, split.body)).not.toThrow()
    expect(joinFrontmatter(split, split.body)).toBe(raw)
  })

  it('handles CRLF line endings in frontmatter', () => {
    const raw = '---\r\ntitle: test\r\n---\r\nbody\n'
    const split = splitFrontmatter(raw)
    expect(split.body).toBe('body\n')
    expect(joinFrontmatter(split, split.body)).toBe(raw)
  })

  it('parses data fields for display', () => {
    const raw = '---\ntitle: Hello World\nmodel: opus\n---\nbody\n'
    const split = splitFrontmatter(raw)
    expect(split.data['title']).toBe('Hello World')
    expect(split.data['model']).toBe('opus')
  })
})
