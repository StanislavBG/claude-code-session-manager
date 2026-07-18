import { describe, it, expect } from 'vitest'
import { verdictLabel, VERDICT_LABELS, projectNameFromCwd, prdNumber } from '../sched-primitives'

describe('verdictLabel', () => {
  it('maps a known verifier verdict to its human-readable label', () => {
    expect(verdictLabel('no_verdict_sentinel')).toBe('no commit or verdict sentinel')
    expect(verdictLabel('transcript_errors')).toBe('transcript had errors')
  })

  it('falls back to the raw verdict string for an unknown value', () => {
    expect(verdictLabel('some_future_verdict')).toBe('some_future_verdict')
  })

  it('covers every key exposed on VERDICT_LABELS', () => {
    for (const key of Object.keys(VERDICT_LABELS)) {
      expect(verdictLabel(key)).toBe(VERDICT_LABELS[key])
    }
  })
})

describe('projectNameFromCwd', () => {
  it('returns the last path segment', () => {
    expect(projectNameFromCwd('/home/bilko/Projects/session-manager')).toBe('session-manager')
  })

  it('returns null for a missing cwd', () => {
    expect(projectNameFromCwd(null)).toBeNull()
    expect(projectNameFromCwd(undefined)).toBeNull()
  })
})

describe('prdNumber', () => {
  it('extracts the leading numeric group from a slug', () => {
    expect(prdNumber('42-my-prd')).toBe('42')
  })

  it('returns null when there is no numeric prefix', () => {
    expect(prdNumber('my-prd')).toBeNull()
  })
})
