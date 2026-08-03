import { describe, it, expect } from 'vitest'
import { verdictLabel, VERDICT_LABELS, projectNameFromCwd, prdNumber, resolveValidatedStatus, prdStatusFor, STATUS_TONE } from '../sched-primitives'

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

describe('resolveValidatedStatus (PRD 987 — traffic light reads the Epic verdict)', () => {
  it('verified validation renders green', () => {
    expect(resolveValidatedStatus('completed', 'verified')).toBe('verified')
    expect(STATUS_TONE.verified.bg).toBe(STATUS_TONE.completed.bg)
  })

  it('refuted validation renders red', () => {
    expect(resolveValidatedStatus('completed', 'refuted')).toBe('refuted')
    expect(STATUS_TONE.refuted.bg).toBe(STATUS_TONE.failed.bg)
  })

  it('validating renders the in-flight treatment', () => {
    expect(resolveValidatedStatus('completed', 'validating')).toBe('validating')
    expect(STATUS_TONE.validating.bg).toBe(STATUS_TONE.running.bg)
  })

  it('a job that reports outcome completed but is unvalidated renders the CLAIMED tone, never green', () => {
    const status = resolveValidatedStatus('completed', 'unvalidated')
    expect(status).toBe('claimed')
    expect(status).not.toBe('completed')
    expect(STATUS_TONE.claimed.bg).not.toBe(STATUS_TONE.completed.bg)
    expect(STATUS_TONE.claimed.label).toContain('not yet verified')
  })

  it('an honestly failed job stays failed regardless of validation', () => {
    expect(resolveValidatedStatus('failed', 'unvalidated')).toBe('failed')
    expect(resolveValidatedStatus('failed', 'verified')).toBe('failed')
  })

  it('needs_review outcome stays needs_review regardless of validation', () => {
    expect(resolveValidatedStatus('needs_review', 'unvalidated')).toBe('needs_review')
  })

  it('no validation stamp at all passes outcome through unchanged (pre-PRD-986 events)', () => {
    expect(resolveValidatedStatus('completed', undefined)).toBe('completed')
    expect(resolveValidatedStatus('running', undefined)).toBe('running')
  })
})

describe('prdStatusFor (PRD 987)', () => {
  it('a completed job with unvalidated verdict resolves to claimed, not completed', () => {
    expect(prdStatusFor({ status: 'completed' }, 'unvalidated')).toBe('claimed')
  })

  it('a completed job with a verified verdict resolves to verified', () => {
    expect(prdStatusFor({ status: 'completed' }, 'verified')).toBe('verified')
  })

  it('with no validation argument, behaves exactly as before (backward compatible)', () => {
    expect(prdStatusFor({ status: 'completed' })).toBe('completed')
    expect(prdStatusFor({ status: 'pending' })).toBe('queued')
    expect(prdStatusFor(null)).toBe('ready')
  })
})
