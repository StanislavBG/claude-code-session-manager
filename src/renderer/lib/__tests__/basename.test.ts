import { describe, expect, it } from 'vitest'
import { basename } from '../basename'

describe('basename', () => {
  it('returns the last segment of a posix path', () => {
    expect(basename('/home/user/docs/readme.md')).toBe('readme.md')
  })
  it('returns the last segment of a windows path', () => {
    expect(basename('C:\\Users\\me\\notes.txt')).toBe('notes.txt')
  })
  it('handles mixed separators', () => {
    expect(basename('a/b\\c.ts')).toBe('c.ts')
  })
  it('ignores trailing separators', () => {
    expect(basename('/a/b/')).toBe('b')
    expect(basename('C:\\a\\b\\')).toBe('b')
  })
  it('returns empty string for empty input', () => {
    expect(basename('')).toBe('')
  })
  it('returns a bare filename unchanged', () => {
    expect(basename('file.txt')).toBe('file.txt')
  })
  it('returns the input when it is only separators', () => {
    expect(basename('/')).toBe('/')
  })
})
