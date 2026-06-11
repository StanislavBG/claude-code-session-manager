/**
 * Unit tests for isRescanCandidate — the predicate gating the boot self-heal
 * pass that re-verifies needs_review jobs with the current verifier.
 *
 * Regression guard for 2026-06-10: verifier fixes (anchored ImportError
 * detectors, harness-tool-error exemption) left 8 jobs stuck in needs_review
 * because the running scheduler held the old verifier. The boot reverify heals
 * transcript-scan false positives — but must NOT touch commit-guard
 * (uncommitted_changes) jobs, which verifyRun cannot re-evaluate.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isRescanCandidate } = require('../../src/main/scheduler.cjs') as {
  isRescanCandidate: (job: unknown) => boolean
}

const base = { status: 'needs_review', runId: '2026-06-10T00-00-00Z', verifierVerdict: 'verify_unavailable' }

describe('isRescanCandidate', () => {
  it('includes transcript_errors needs_review jobs with a runId', () => {
    expect(isRescanCandidate({ ...base, verifierVerdict: 'transcript_errors' })).toBe(true)
  })

  it('includes verify_unavailable needs_review jobs with a runId', () => {
    expect(isRescanCandidate(base)).toBe(true)
  })

  it('EXCLUDES commit-guard (uncommitted_changes) jobs — verifyRun cannot see git', () => {
    expect(isRescanCandidate({ ...base, verifierVerdict: 'uncommitted_changes' })).toBe(false)
  })

  it('excludes jobs without a runId (no log to re-scan)', () => {
    expect(isRescanCandidate({ ...base, runId: undefined })).toBe(false)
  })

  it('excludes non-needs_review statuses', () => {
    expect(isRescanCandidate({ ...base, status: 'completed' })).toBe(false)
    expect(isRescanCandidate({ ...base, status: 'pending' })).toBe(false)
  })

  it('excludes jobs with no verdict / unknown verdict', () => {
    expect(isRescanCandidate({ ...base, verifierVerdict: undefined })).toBe(false)
    expect(isRescanCandidate({ ...base, verifierVerdict: 'halt' })).toBe(false)
  })

  it('handles null/garbage input without throwing', () => {
    expect(isRescanCandidate(null)).toBe(false)
    expect(isRescanCandidate({})).toBe(false)
  })
})
