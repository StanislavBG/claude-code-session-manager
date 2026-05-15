/**
 * PRD frontmatter parse/serialize round-trip.
 *
 * The scheduler Retag flow writes back to disk; any serializer regression
 * silently corrupts user PRDs. This spec locks in byte-identical round-trip
 * for the canonical fixtures (title + cwd + estimateMinutes ± parallelGroup
 * ± extras).
 *
 * Source: src/renderer/lib/prdFrontmatter.ts (used by SchedulerPrdsView and
 * queueOps.cjs retag path).
 */
import { describe, it, expect } from 'vitest'
import { parsePrdFile, serializePrdFile } from '../../src/renderer/lib/prdFrontmatter'

describe('prdFrontmatter round-trip', () => {
  const cases = [
    {
      name: 'minimal (title + cwd + estimateMinutes)',
      text: '---\ntitle: foo\ncwd: /tmp\nestimateMinutes: 5\n---\nbody\n',
    },
    {
      name: 'with parallelGroup',
      text: '---\ntitle: bar\ncwd: /tmp\nestimateMinutes: 10\nparallelGroup: 7\n---\nbody2\n',
    },
    {
      name: 'with custom field (extras band)',
      text: '---\ntitle: baz\ncwd: /tmp\nestimateMinutes: 3\ncustomField: hello\n---\nbody3\n',
    },
  ]

  for (const c of cases) {
    it(`${c.name} round-trips byte-identical`, () => {
      const { frontmatter, body } = parsePrdFile(c.text)
      const out = serializePrdFile(frontmatter, body)
      expect(out).toBe(c.text)
    })
  }

  it('parses the title, cwd, and estimateMinutes fields', () => {
    const text = '---\ntitle: my prd\ncwd: /a/b\nestimateMinutes: 42\n---\n# Body\n'
    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter.title).toBe('my prd')
    expect(frontmatter.cwd).toBe('/a/b')
    expect(frontmatter.estimateMinutes).toBe(42)
    expect(body).toBe('# Body\n')
  })

  it('preserves unknown frontmatter keys in extras', () => {
    const text = '---\ntitle: x\ncwd: /tmp\nestimateMinutes: 1\nweirdKey: weirdValue\n---\nbody\n'
    const { frontmatter } = parsePrdFile(text)
    expect(frontmatter.extras?.weirdKey).toBeDefined()
    expect(frontmatter.extras?.weirdKey.lines).toEqual(['weirdKey: weirdValue'])
  })

  it('no-frontmatter input returns body unchanged via parse', () => {
    // Documents the parser's behavior — when there's no `---` block, the
    // whole text is body. (serializePrdFile always emits a `---` wrapper,
    // so the inverse is NOT byte-identical for plain-body input; callers
    // should not serialize a frontmatter-less PRD.)
    const text = 'just body\n'
    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter).toEqual({})
    expect(body).toBe('just body\n')
  })
})
