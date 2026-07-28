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
