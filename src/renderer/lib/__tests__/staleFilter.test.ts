import { describe, it, expect } from 'vitest'
import { filterEntries } from '../staleFilter'
import type { MemoryEntry, MemoryStaleEntry } from '../../../preload/api'

function entry(name: string): MemoryEntry {
  return { name, path: `/tmp/${name}`, mtimeMs: 0, bytes: 10 }
}

function staleEntry(name: string, stale: boolean, reasons: string[] = []): MemoryStaleEntry {
  return { name, ageDays: 100, inboundLinks: 0, deadRefs: [], stale, reasons }
}

describe('filterEntries', () => {
  const entries = [entry('alpha.md'), entry('beta.md'), entry('gamma.md')]

  it('applies text filter alone', () => {
    const result = filterEntries(entries, 'al', false, {})
    expect(result.map((e) => e.name)).toEqual(['alpha.md'])
  })

  it('applies stale-only alone', () => {
    const staleByName = {
      'alpha.md': staleEntry('alpha.md', true, ['90+ days old']),
      'beta.md': staleEntry('beta.md', false),
    }
    const result = filterEntries(entries, '', true, staleByName)
    expect(result.map((e) => e.name)).toEqual(['alpha.md'])
  })

  it('combines text filter and stale-only', () => {
    const staleByName = {
      'alpha.md': staleEntry('alpha.md', true),
      'beta.md': staleEntry('beta.md', true),
    }
    const result = filterEntries(entries, 'be', true, staleByName)
    expect(result.map((e) => e.name)).toEqual(['beta.md'])
  })

  it('returns empty list when stale-only is set but staleByName is empty', () => {
    const result = filterEntries(entries, '', true, {})
    expect(result).toEqual([])
  })
})
