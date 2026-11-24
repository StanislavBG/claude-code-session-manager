import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { AIM_PARTS } from '../../src/renderer/lib/epicIntake'

const require = createRequire(import.meta.url)
const { EpicIntakeSectionSchema } = require('../../src/main/lib/promptSessionSchema.cjs') as {
  EpicIntakeSectionSchema: { shape: { part: { unwrap: () => { options: readonly string[] } } } }
}

describe('AIM parts drift', () => {
  it("renderer AIM_PARTS matches main's EpicIntakeSectionSchema part enum", () => {
    // Hand-kept mirrors: a part main does not know makes promptSessions:create-epic reject the whole Epic.
    expect([...AIM_PARTS].sort()).toEqual([...EpicIntakeSectionSchema.shape.part.unwrap().options].sort())
  })
})
