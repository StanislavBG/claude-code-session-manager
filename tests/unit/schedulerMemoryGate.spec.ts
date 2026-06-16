/**
 * Unit tests for memoryLimitedBatchSize — the pure helper that clamps the
 * scheduler's launch batch when available system memory is low.
 *
 * Incident coverage: 2026-06-10 OOM killed Electron when 5 concurrent claude -p
 * jobs exhausted 23 GB RAM. Gate ensures each new slot has at least
 * MIN_FREE_MB_PER_JOB (1500 MB) headroom.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { memoryLimitedBatchSize, availableForJobs } = require('../../src/main/scheduler.cjs') as {
  memoryLimitedBatchSize: (availableMb: number, minPerJob: number, runningCount: number, batchLen: number) => number
  availableForJobs: (availableMb: number, reservedHostMb: number) => number
}

const MIN = 1500

describe('memoryLimitedBatchSize', () => {
  it('passes full batch when memory is ample', () => {
    // 0 running, 3 in batch, 20 GB free → allow all 3
    expect(memoryLimitedBatchSize(20_000, MIN, 0, 3)).toBe(3)
  })

  it('passes full batch when availableMb is Infinity (non-Linux / fail-open)', () => {
    expect(memoryLimitedBatchSize(Infinity, MIN, 0, 5)).toBe(5)
  })

  it('allows 0 when even 1 job would exceed threshold (0 running)', () => {
    // need MIN*1 = 1500 MB; only 1000 available
    expect(memoryLimitedBatchSize(1000, MIN, 0, 3)).toBe(0)
  })

  it('allows 0 when running jobs already consume headroom', () => {
    // 3 running, need 1500*4 = 6000 for +1; only 5999 available
    expect(memoryLimitedBatchSize(5999, MIN, 3, 2)).toBe(0)
  })

  it('clamps batch from 3 to 1 when memory is tight', () => {
    // 0 running; need 1500*3=4500 for 3 jobs, 1500*2=3000 for 2, 1500*1=1500 for 1
    // available=2000 → allows 1 (2000 >= 1500*1), not 2 (2000 < 1500*2)
    expect(memoryLimitedBatchSize(2000, MIN, 0, 3)).toBe(1)
  })

  it('clamps batch from 2 to 1 when 1 job is already running', () => {
    // 1 running; need 1500*2=3000 for 1 more, 1500*3=4500 for 2 more
    // available=3500 → allows 1 (3500 >= 3000), not 2 (3500 < 4500)
    expect(memoryLimitedBatchSize(3500, MIN, 1, 2)).toBe(1)
  })

  it('passes batch of 0 unchanged (no-op)', () => {
    expect(memoryLimitedBatchSize(1000, MIN, 0, 0)).toBe(0)
  })

  it('allows exactly at boundary (available === minPerJob * slots)', () => {
    // 0 running, batch=2; need 3000; available=3000 → allows 2
    expect(memoryLimitedBatchSize(3000, MIN, 0, 2)).toBe(2)
  })

  it('one below boundary is clamped', () => {
    expect(memoryLimitedBatchSize(2999, MIN, 0, 2)).toBe(1)
  })
})

// availableForJobs — host-reserve guard (2026-06-16 OOM-kills-Electron fix).
// Subtracts a fixed host headroom from MemAvailable before the per-job gate, so
// the gate can never lend the host's own memory to a job and starve Electron.
describe('availableForJobs', () => {
  const RESERVE = 3000

  it('subtracts the host reserve from MemAvailable', () => {
    expect(availableForJobs(10_000, RESERVE)).toBe(7000)
  })

  it('floors at 0 when MemAvailable is below the reserve', () => {
    // host already starved → 0 budget → gate defers all jobs
    expect(availableForJobs(2038, RESERVE)).toBe(0)
    expect(memoryLimitedBatchSize(availableForJobs(2038, RESERVE), MIN, 0, 3)).toBe(0)
  })

  it('fails open (Infinity) on non-Linux where MemAvailable is unknown', () => {
    expect(availableForJobs(Infinity, RESERVE)).toBe(Infinity)
  })

  it('composed gate: 3 GB reserve + 2.5 GB/job needs ~5.5 GB free to start one job', () => {
    const MIN_JOB = 2500
    // 5000 MB available → 2000 after reserve → 0 jobs (need 2500 for one)
    expect(memoryLimitedBatchSize(availableForJobs(5000, RESERVE), MIN_JOB, 0, 2)).toBe(0)
    // 5600 MB available → 2600 after reserve → exactly 1 job
    expect(memoryLimitedBatchSize(availableForJobs(5600, RESERVE), MIN_JOB, 0, 2)).toBe(1)
  })
})
