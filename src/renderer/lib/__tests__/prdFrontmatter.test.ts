import { describe, it, expect } from 'vitest'
import { parsePrdFile, serializePrdFile } from '../prdFrontmatter'

describe('prdFrontmatter sourcePromptId (PRD 749)', () => {
  it('parses sourcePromptId when present', () => {
    const text = [
      '---',
      'title: Has a source ticket',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 10',
      'sourcePromptId: ticket-xyz-789',
      '---',
      '# Goal',
      '',
      'Do the thing.',
      '',
    ].join('\n')

    const { frontmatter } = parsePrdFile(text)
    expect(frontmatter.sourcePromptId).toBe('ticket-xyz-789')
    expect(frontmatter.title).toBe('Has a source ticket')
  })

  it('leaves sourcePromptId undefined for a PRD authored before this field existed — no required-field regression', () => {
    const text = [
      '---',
      'title: Legacy PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 5',
      '---',
      '# Goal',
      '',
      'Do the other thing.',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter.sourcePromptId).toBeUndefined()
    expect(frontmatter.title).toBe('Legacy PRD')
    expect(frontmatter.estimateMinutes).toBe(5)
    // round-trips byte-identical when nothing changed
    expect(serializePrdFile(frontmatter, body)).toBe(text)
  })

  it('round-trips a file with sourcePromptId byte-identically when unedited', () => {
    const text = [
      '---',
      'title: Has a source ticket',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 10',
      'sourcePromptId: ticket-xyz-789',
      '---',
      '# Goal',
      '',
      'Do the thing.',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    expect(serializePrdFile(frontmatter, body)).toBe(text)
  })

  it('serializes a newly-set sourcePromptId onto a frontmatter object that lacked one', () => {
    const text = [
      '---',
      'title: Legacy PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 5',
      '---',
      'body',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    const updated = serializePrdFile({ ...frontmatter, sourcePromptId: 'ticket-new-1' }, body)
    expect(updated).toContain('sourcePromptId: ticket-new-1')
  })
})

describe('prdFrontmatter tag (PRD 774)', () => {
  it('parses tag when present', () => {
    const text = [
      '---',
      'title: Has a tag',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 10',
      'tag: bug',
      '---',
      '# Goal',
      '',
      'Do the thing.',
      '',
    ].join('\n')

    const { frontmatter } = parsePrdFile(text)
    expect(frontmatter.tag).toBe('bug')
  })

  it('leaves tag undefined for a PRD authored before this field existed — no required-field regression', () => {
    const text = [
      '---',
      'title: Legacy PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 5',
      '---',
      '# Goal',
      '',
      'Do the other thing.',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter.tag).toBeUndefined()
    // round-trips byte-identical when nothing changed
    expect(serializePrdFile(frontmatter, body)).toBe(text)
  })

  it('round-trips a file with tag byte-identically when unedited', () => {
    const text = [
      '---',
      'title: Has a tag',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 10',
      'tag: feature',
      '---',
      '# Goal',
      '',
      'Do the thing.',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    expect(serializePrdFile(frontmatter, body)).toBe(text)
  })

  it('serializes a newly-set tag onto a frontmatter object that lacked one', () => {
    const text = [
      '---',
      'title: Legacy PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 5',
      '---',
      'body',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    const updated = serializePrdFile({ ...frontmatter, tag: 'bug' }, body)
    expect(updated).toContain('tag: bug')
  })
})

describe('prdFrontmatter dependsOn (PRD 1124)', () => {
  it('parses an inline dependsOn list into an array, and round-trips it byte-identically when unedited', () => {
    const text = [
      '---',
      'title: A follow-up PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 20',
      'dependsOn: [widget-base, widget-shared]',
      '---',
      '# Goal',
      '',
      'Build on the base.',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter.dependsOn).toEqual(['widget-base', 'widget-shared'])
    expect(serializePrdFile(frontmatter, body)).toBe(text)
  })

  it('leaves dependsOn undefined when omitted — a PRD with no dependsOn is unaffected by an unrelated patch', () => {
    const text = [
      '---',
      'title: Legacy PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 5',
      '---',
      '# Goal',
      '',
      'Do the other thing.',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter.dependsOn).toBeUndefined()
    const updated = serializePrdFile({ ...frontmatter, title: 'Renamed' }, body)
    expect(updated).not.toContain('dependsOn')
  })

  it('patches an existing dependsOn to a new list', () => {
    const text = [
      '---',
      'title: A follow-up PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 20',
      'dependsOn: [widget-base]',
      '---',
      'body',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    const updated = serializePrdFile({ ...frontmatter, dependsOn: ['widget-shared'] }, body)
    expect(updated).toContain('dependsOn: [widget-shared]')
    expect(updated).not.toContain('widget-base')
  })

  it('patching dependsOn to an explicit empty array clears it', () => {
    const text = [
      '---',
      'title: A follow-up PRD',
      'cwd: ~/Projects/session-manager',
      'estimateMinutes: 20',
      'dependsOn: [widget-base]',
      '---',
      'body',
      '',
    ].join('\n')

    const { frontmatter, body } = parsePrdFile(text)
    const updated = serializePrdFile({ ...frontmatter, dependsOn: [] }, body)
    expect(updated).not.toContain('dependsOn')
  })
})

describe('planId key', () => {
  it('parses and re-emits planId after disposition', () => {
    const text = '---\ntitle: t\ndisposition: new-head\nplanId: pl-x1-abc123\n---\nb\n'
    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter.planId).toBe('pl-x1-abc123')
    expect(serializePrdFile(frontmatter, body)).toBe(text)
  })
  it('drops a malformed planId instead of throwing', () => {
    expect(parsePrdFile('---\ntitle: t\nplanId: [a, b]\n---\nb\n').frontmatter.planId).toBeUndefined()
  })
})

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

describe('renderer planId garbage', () => {
  it('renderer parser ignores a garbage planId', () => {
    expect(parsePrdFile('---\ntitle: p\nplanId: a b, [c]\n---\nx\n').frontmatter.planId).toBeUndefined()
  })
})

describe('prdFrontmatter planId round-trip (renderer + main parser)', () => {
  const text = '---\ntitle: p\ncwd: /tmp\nestimateMinutes: 5\ndisposition: append\nplanId: pl-abc123-ff00aa\n---\nbody\n'
  it('renderer parser round-trips planId byte-identical', () => {
    const { frontmatter, body } = parsePrdFile(text)
    expect(frontmatter.planId).toBe('pl-abc123-ff00aa')
    expect(serializePrdFile(frontmatter, body)).toBe(text)
  })
  it('main parser round-trips planId byte-identical and drops garbage', async () => {
    // @ts-expect-error — CJS main module has no type declarations
    const main = await import('../../../main/lib/prdFrontmatter.cjs') as any
    const { frontmatter, body } = main.parsePrdFile(text)
    expect(frontmatter.planId).toBe('pl-abc123-ff00aa')
    expect(main.serializePrdFile(frontmatter, body)).toBe(text)
    expect(main.parsePrdFile('---\ntitle: p\nplanId: a b, [c]\n---\nx\n').frontmatter.planId).toBeUndefined()
  })
})
