import { describe, it, expect } from 'vitest'
import { isRawModel, RAW_MODELS } from '../../src/renderer/lib/rawSessionModel'

describe('rawSessionModel', () => {
  it('isRawModel accepts the four known models', () => {
    expect(isRawModel('opus')).toBe(true)
    expect(isRawModel('sonnet')).toBe(true)
    expect(isRawModel('haiku')).toBe(true)
    expect(isRawModel('fable')).toBe(true)
  })

  it('isRawModel rejects unknown strings', () => {
    expect(isRawModel('gpt4')).toBe(false)
  })

  it('RAW_MODELS contains exactly opus, sonnet, haiku, fable', () => {
    expect(RAW_MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable'])
  })
})
