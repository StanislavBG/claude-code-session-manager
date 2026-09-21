'use strict'

const { check } = require('../check-tracked-filenames.cjs')

describe('check-tracked-filenames', () => {
  it('passes a clean list', () => {
    expect(check(['src/main/a.cjs', 'README.md', 'a b/c.d.ts', '.github/x.yml', 'console/x.ts'])).toEqual([])
  })
  it('flags the literal <path> junk file', () => {
    expect(check(['<path>'])).toHaveLength(1)
  })
  it('flags a colon in a name', () => {
    expect(check(['a/b:c.txt'])).toHaveLength(1)
  })
  it('flags reserved device names with extension, case-insensitive', () => {
    expect(check(['dir/NUL.txt', 'x/com1', 'lpt9.md'])).toHaveLength(3)
  })
  it('flags trailing dot or space in a segment', () => {
    expect(check(['trailing./x', 'a/b '])).toHaveLength(2)
  })
  it('flags control characters', () => {
    expect(check(['a\tb'])).toHaveLength(1)
  })
})
