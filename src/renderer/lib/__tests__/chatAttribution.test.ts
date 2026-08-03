import { describe, expect, it } from 'vitest'
import { extractAttribution } from '../chatAttribution'

describe('extractAttribution', () => {
  it('CORE: pulls every documented attribution field off a raw projection', () => {
    const raw = {
      attributionSkill: 'develop',
      attributionPlugin: 'session-manager-dev',
      attributionMcpServer: 'some-server',
      attributionMcpTool: 'some_tool',
      effort: 'high',
      gitBranch: 'main',
      isSidechain: true,
      isMeta: true,
      isApiErrorMessage: true,
      interruptedByShutdown: true,
      // Fields NOT in the documented set must not leak through.
      someOtherField: 'ignored',
    }
    expect(extractAttribution(raw)).toEqual({
      attributionSkill: 'develop',
      attributionPlugin: 'session-manager-dev',
      attributionMcpServer: 'some-server',
      attributionMcpTool: 'some_tool',
      effort: 'high',
      gitBranch: 'main',
      isSidechain: true,
      isMeta: true,
      isApiErrorMessage: true,
      interruptedByShutdown: true,
    })
  })

  it('EDGE: returns undefined (not an empty object) when raw carries none of these fields', () => {
    expect(extractAttribution({ timestamp: '2026-01-01T00:00:00Z', message: {} })).toBeUndefined()
  })

  it('EDGE: returns undefined for null/non-object raw', () => {
    expect(extractAttribution(null)).toBeUndefined()
    expect(extractAttribution(undefined)).toBeUndefined()
    expect(extractAttribution('a string')).toBeUndefined()
  })

  it('omits false-valued booleans rather than including isSidechain: false', () => {
    const out = extractAttribution({ isSidechain: false, gitBranch: 'main' })
    expect(out).toEqual({ gitBranch: 'main' })
    expect(out).not.toHaveProperty('isSidechain')
  })
})
