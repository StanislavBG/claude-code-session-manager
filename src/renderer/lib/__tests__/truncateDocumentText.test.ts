import { describe, it, expect } from 'vitest'
import { truncateDocumentText, MAX_DOC_CONTEXT } from '../truncateDocumentText'

describe('truncateDocumentText', () => {
  it('passes short text through unchanged', () => {
    expect(truncateDocumentText('short')).toBe('short')
  })

  it('truncates to the head+tail scheme, dropping the middle', () => {
    const head = 'H'.repeat(40000)
    const tail = 'T'.repeat(20000)
    const middle = 'M'.repeat(10000)
    const result = truncateDocumentText(head + middle + tail)
    expect(result).toBe(`${head}\n\n[...document truncated for length...]\n\n${tail}`)
    expect(result).not.toContain('M')
  })

  it('caps well within the ipcSchemas.cjs documentText max (60100)', () => {
    const huge = 'x'.repeat(MAX_DOC_CONTEXT + 500000)
    const result = truncateDocumentText(huge)
    expect(result.length).toBeLessThan(60100)
  })
})
