'use strict'

// Pure diff/compare logic for scripts/sync-settings-schema.cjs. Deliberately
// exercises diffSchemas() only, against small in-repo fixture objects — never
// the network fetch (see the script's own header comment for why).

import { describe, it, expect } from 'vitest'
const { diffSchemas } = require('../sync-settings-schema.cjs')

describe('diffSchemas', () => {
  it('reports no differences for identical property sets', () => {
    const props = { a: { type: 'string' }, b: { type: 'boolean' } }
    const result = diffSchemas(props, props)
    expect(result).toEqual({ added: [], changed: [], removed: [] })
  })

  it('reports a key present upstream but not locally as added', () => {
    const local = { a: { type: 'string' } }
    const upstream = { a: { type: 'string' }, b: { type: 'boolean' } }
    const result = diffSchemas(local, upstream)
    expect(result).toEqual({ added: ['b'], changed: [], removed: [] })
  })

  it('reports a key present locally but not upstream as removed', () => {
    const local = { a: { type: 'string' }, b: { type: 'boolean' } }
    const upstream = { a: { type: 'string' } }
    const result = diffSchemas(local, upstream)
    expect(result).toEqual({ added: [], changed: [], removed: ['b'] })
  })

  it('reports a key whose definition differs between local and upstream as changed', () => {
    const local = { effortLevel: { type: 'string', enum: ['low', 'medium', 'high'] } }
    const upstream = { effortLevel: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] } }
    const result = diffSchemas(local, upstream)
    expect(result).toEqual({ added: [], changed: ['effortLevel'], removed: [] })
  })

  it('sorts each bucket alphabetically and combines added/changed/removed independently', () => {
    const local = { z: { type: 'string' }, m: { type: 'string' }, gone: { type: 'string' } }
    const upstream = { z: { type: 'boolean' }, m: { type: 'string' }, added1: {}, added2: {} }
    const result = diffSchemas(local, upstream)
    expect(result).toEqual({ added: ['added1', 'added2'], changed: ['z'], removed: ['gone'] })
  })
})
