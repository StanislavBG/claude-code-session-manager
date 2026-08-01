import { describe, expect, it } from 'vitest'
import { computeLineDiff } from './lineDiff'

describe('computeLineDiff', () => {
  it('marks every line as added when oldText is undefined (Write tool_use)', () => {
    const result = computeLineDiff(undefined, 'line one\nline two')
    expect(result.added).toBe(2)
    expect(result.removed).toBe(0)
    expect(result.lines).toEqual([
      { type: 'add', text: 'line one' },
      { type: 'add', text: 'line two' },
    ])
  })

  it('diffs old_string/new_string into context/add/remove lines (Edit tool_use)', () => {
    const oldText = 'const a = 1\nconst b = 2\nconst c = 3'
    const newText = 'const a = 1\nconst b = 20\nconst c = 3'
    const result = computeLineDiff(oldText, newText)
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    expect(result.lines).toEqual([
      { type: 'context', text: 'const a = 1' },
      { type: 'remove', text: 'const b = 2' },
      { type: 'add', text: 'const b = 20' },
      { type: 'context', text: 'const c = 3' },
    ])
  })

  it('handles a pure insertion with no removals', () => {
    const result = computeLineDiff('one\ntwo', 'one\ntwo\nthree')
    expect(result.added).toBe(1)
    expect(result.removed).toBe(0)
  })

  it('handles a pure deletion with no additions', () => {
    const result = computeLineDiff('one\ntwo\nthree', 'one\nthree')
    expect(result.added).toBe(0)
    expect(result.removed).toBe(1)
  })

  it('does not produce a spurious empty-line diff when only one side has a trailing newline', () => {
    const result = computeLineDiff('const a = 1\n', 'const a = 1')
    expect(result.lines).toEqual([{ type: 'context', text: 'const a = 1' }])
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
  })
})
