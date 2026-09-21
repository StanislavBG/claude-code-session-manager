import { describe, it, expect } from 'vitest'
import { prettyModel, modelFamily } from '../prettyModel'

describe('prettyModel', () => {
  const cases: Array<[string, string]> = [
    // Fable — the family this PRD teaches the helper.
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-fable-5-1[1m]', 'Fable 5.1 1m'],
    // Existing behaviour must be unchanged.
    ['claude-opus-5', 'Opus 5'],
    ['claude-sonnet-4-6-20250514', 'Sonnet 4.6'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-opus-4-7[1m]', 'Opus 4.7 1m'],
    // Documented fallback contract.
    ['some-future-model-9', 'some-future-model-9'],
    // Bare aliases with no version digits — no expansion here.
    ['opus', 'opus'],
    ['fable', 'fable'],
    // Sentinels short-circuit unchanged.
    ['', ''],
    ['—', '—'],
    ['unknown', 'unknown'],
  ]

  it.each(cases)('prettyModel(%j) -> %j', (input, expected) => {
    expect(prettyModel(input)).toBe(expected)
  })
})

describe('modelFamily', () => {
  it('derives the family from ids and aliases, null for non-family aliases', () => {
    expect(modelFamily('claude-opus-4-8')).toBe('opus')
    expect(modelFamily('sonnet[1m]')).toBe('sonnet')
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(modelFamily('best')).toBeNull()
    expect(modelFamily('opusplan')).toBe('opus')
  })
  it('prettyModel never blanks bracketed/non-family aliases', () => {
    expect(prettyModel('opus[1m]')).toBe('opus[1m]')
    expect(prettyModel('best')).toBe('best')
  })
})
