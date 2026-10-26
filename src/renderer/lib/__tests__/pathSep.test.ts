import { describe, it, expect } from 'vitest'
import { dirname, basename, join, segments, isUnder } from '../pathSep'
import { compactPath } from '../compactPath'

describe('pathSep', () => {
  it('dirname', () => {
    expect(dirname('/tmp/project/a.txt')).toBe('/tmp/project')
    expect(dirname('C:\\Users\\me\\proj\\a.txt')).toBe('C:\\Users\\me\\proj')
    expect(dirname('C:\\a')).toBe('C:\\')
    expect(dirname('/a')).toBe('/')
    expect(dirname('a')).toBe('')
  })
  it('basename/segments', () => {
    expect(basename('C:\\Users\\me\\proj\\')).toBe('proj')
    expect(basename('/x/y')).toBe('y')
    expect(segments('C:\\Users\\me')).toEqual(['C:', 'Users', 'me'])
  })
  it('join keeps style', () => {
    expect(join('C:\\Users\\me', 'proj')).toBe('C:\\Users\\me\\proj')
    expect(join('/tmp/', '/a')).toBe('/tmp/a')
  })
  it('isUnder', () => {
    expect(isUnder('C:\\p\\a', 'C:\\p')).toBe(true)
    expect(isUnder('C:\\pa\\a', 'C:\\p')).toBe(false)
    expect(isUnder('C:\\p', 'C:\\p')).toBe(false)
    expect(isUnder('/p/a', '/p')).toBe(true)
  })
  it('compactPath windows', () => {
    expect(compactPath('C:\\Users\\me\\proj', 'C:\\Users\\me')).toBe('~\\proj')
    expect(compactPath('C:\\Users\\me', 'C:\\Users\\me\\')).toBe('~')
  })
})
