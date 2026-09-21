import { describe, it, expect } from 'vitest'
import { isRawModel, RAW_MODELS, rawModelOptions } from '../../src/renderer/lib/rawSessionModel'

describe('rawSessionModel', () => {
  it('isRawModel accepts the four known models', () => {
    expect(isRawModel('opus')).toBe(true)
    expect(isRawModel('sonnet')).toBe(true)
    expect(isRawModel('haiku')).toBe(true)
    expect(isRawModel('fable')).toBe(true)
  })

  it('isRawModel rejects malformed strings', () => {
    expect(isRawModel('gpt 4')).toBe(false)
    expect(isRawModel('')).toBe(false)
  })

  it('isRawModel accepts concrete ids and [1m] aliases', () => {
    expect(isRawModel('claude-opus-5')).toBe(true)
    expect(isRawModel('opus[1m]')).toBe(true)
    expect(isRawModel("a'; rm -rf /")).toBe(false)
  })

  it('RAW_MODELS is the four-alias fallback list, and null catalog yields exactly it', () => {
    expect(RAW_MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable'])
    expect(rawModelOptions(null)).toEqual(RAW_MODELS)
  })

  it('rawModelOptions expands catalog aliases + concrete ids with [1m] variants', () => {
    const o = rawModelOptions({ aliases: ['opus'], models: ['claude-opus-5'] })
    expect(o).toEqual(['opus', 'opus[1m]', 'claude-opus-5', 'claude-opus-5[1m]'])
  })
})
