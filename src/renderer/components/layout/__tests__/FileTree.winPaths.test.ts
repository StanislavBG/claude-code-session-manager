import { describe, it, expect } from 'vitest'
import { pruneExpanded, displayName } from '../FileTree'
import { dirname } from '../../../lib/pathSep'

const P = 'C:\\Users\\me\\proj'

describe('FileTree with Windows paths', () => {
  it('rename keeps the right parent', () => {
    expect(dirname(`${P}\\src\\a.ts`)).toBe(`${P}\\src`)
  })
  it('pruneExpanded drops descendants only', () => {
    const set = new Set([`${P}\\src`, `${P}\\src\\deep`, `${P}\\srcother`])
    expect([...pruneExpanded(set, `${P}\\src`)]).toEqual([`${P}\\srcother`])
  })
  it('displayName', () => {
    expect(displayName(P)).toBe('proj')
  })
})
