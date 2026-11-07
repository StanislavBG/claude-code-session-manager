import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { TAG_LIBRARY } from '../tagLibrary'

// Main ships separately from the renderer, so the 7-tag taxonomy lives in two
// files. This guard fails when their ids (values or order) drift apart.
const nodeRequire = createRequire(import.meta.url)

describe('tag taxonomy parity', () => {
  it('renderer TAG_LIBRARY ids equal main WORK_TYPES, in order', () => {
    const { WORK_TYPES } = nodeRequire('../../../main/lib/prd/workTypeLibrary.cjs') as {
      WORK_TYPES: readonly string[]
    }
    expect(TAG_LIBRARY.map((e) => e.tag)).toEqual([...WORK_TYPES])
  })
})
