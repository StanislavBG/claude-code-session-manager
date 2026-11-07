import { describe, it, expect } from 'vitest'
import { LEARNING_CONTENT } from '../learningContent'
import { mergeScopes } from '../../lib/mergeScopes'

describe('settings Learn text vs mergeScopes', () => {
  it('does not claim objects fail to merge, and states the real rule', () => {
    const text = JSON.stringify(LEARNING_CONTENT.settings)
    expect(text).not.toMatch(/objects do not/i)
    expect(text).not.toMatch(/REPLACES the user-scoped object/)
    expect(text).toMatch(/Objects merge key by key/)
    expect(text).toMatch(/Local beats Project beats User/)
  })

  it('mergeScopes merges a nested object from two scopes', () => {
    const node = mergeScopes([
      { scope: 'user', data: { a: { x: 1 } } },
      { scope: 'project', data: { a: { y: 2 } } },
    ] as never)
    expect(node.kind).toBe('object')
    const a = (node as any).children.a
    expect(a.kind).toBe('object')
    expect(Object.keys(a.children).sort()).toEqual(['x', 'y'])
  })
})
