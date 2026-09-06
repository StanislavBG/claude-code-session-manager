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
