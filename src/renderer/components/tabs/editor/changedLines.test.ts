import { describe, it, expect } from 'vitest'
import { changedLines, changedBlocks, stripMarkdown } from './changedLines'

describe('changedLines', () => {
  it('identical text marks nothing', () => {
    const t = '# Title\n\nOne line.\nTwo line.\n'
    expect(changedLines(t, t)).toEqual([])
  })

  it('marks a modified line', () => {
    expect(changedLines('a\nb\nc', 'a\nB\nc')).toEqual([2])
  })

  it('marks an added line', () => {
    expect(changedLines('a\nb\nc', 'a\nb\nnew\nc')).toEqual([3])
  })

  it('a removed line leaves no mark', () => {
    expect(changedLines('a\nb\nc', 'a\nc')).toEqual([])
  })

  it('marks every line when the baseline is empty', () => {
    expect(changedLines('', 'x\ny')).toEqual([1, 2])
  })
})

describe('changedBlocks', () => {
  it('returns only the edited paragraph of a two-paragraph edit', () => {
    const before = 'First paragraph stays.\n\nSecond paragraph old.\n'
    const after = 'First paragraph stays.\n\nSecond paragraph new\nwith a second line.\n'
    expect(changedBlocks(before, after)).toEqual(['Second paragraph new\nwith a second line.'])
  })

  it('identical text has no changed blocks', () => {
    const t = 'A\n\nB'
    expect(changedBlocks(t, t)).toEqual([])
  })
})

describe('stripMarkdown', () => {
  it('drops heading, list and emphasis syntax', () => {
    expect(stripMarkdown('## Before you **say** it')).toBe('Before you say it')
    expect(stripMarkdown('- Run the `test` [cmd](http://x).')).toBe('Run the test cmd.')
  })
})
