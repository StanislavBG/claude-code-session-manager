/**
 * Scheduler reliability: finish-protocol injection + commit-guard porcelain parse.
 *
 * These lock the two reliability guarantees added so the queue can be relied on
 * to finish work to a consistent bar (review → security-review → verify →
 * commit) and never silently mark an uncommitted job "completed".
 *
 * Source: src/main/scheduler.cjs (parsePorcelain, FINISH_PROTOCOL).
 */
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parsePorcelain, FINISH_PROTOCOL } = require('../../src/main/scheduler.cjs')

describe('parsePorcelain (commit guard)', () => {
  it('returns [] for an empty / clean tree', () => {
    expect(parsePorcelain('')).toEqual([])
    expect(parsePorcelain('\n')).toEqual([])
    expect(parsePorcelain(undefined)).toEqual([])
  })

  it('extracts paths across modified / added / untracked / renamed lines', () => {
    const out = [
      ' M src/a.ts',
      '?? src/new.ts',
      'A  src/added.ts',
      'R  old.ts -> new.ts',
    ].join('\n')
    expect(parsePorcelain(out)).toEqual([
      'src/a.ts',
      'src/new.ts',
      'src/added.ts',
      'old.ts -> new.ts',
    ])
  })

  it('a non-empty result is how the guard knows the COMMIT step did not run', () => {
    expect(parsePorcelain(' M f.ts').length).toBeGreaterThan(0)
  })
})

describe('FINISH_PROTOCOL', () => {
  it('mandates the exact review → security-review → verify → commit sequence', () => {
    expect(FINISH_PROTOCOL).toMatch(/\/code-review/)
    expect(FINISH_PROTOCOL).toMatch(/\/security-review/)
    expect(FINISH_PROTOCOL).toMatch(/git add -A && git commit/)
    // ordering: code-review before security-review before commit
    const iCode = FINISH_PROTOCOL.indexOf('/code-review')
    const iSec = FINISH_PROTOCOL.indexOf('/security-review')
    const iCommit = FINISH_PROTOCOL.indexOf('git commit')
    expect(iCode).toBeLessThan(iSec)
    expect(iSec).toBeLessThan(iCommit)
  })

  it('reinforces the no-bonus-work bound', () => {
    expect(FINISH_PROTOCOL).toMatch(/beyond the acceptance criteria/i)
  })
})
