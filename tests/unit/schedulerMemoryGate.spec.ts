/**
 * Unit tests for the scheduler's memory launch gate — loadGate.measuredMemoryGate
 * with an EMPTY sample store, whose too-few-samples fallback is the old flat rule:
 * every job (running or new) reserves 2,500 MB, no spike buffer. Plus
 * availableForJobs, the host-reserve guard applied before the gate.
 *
 * Incident coverage: 2026-06-10 OOM killed Electron when 5 concurrent claude -p
 * jobs exhausted 23 GB RAM. The gate ensures each new slot has headroom.
 * (PRD 4019 replaced the flat helper with measured reservations; PRD 4081 moved
 * these cases onto the measured gate's fallback.)
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { availableForJobs } = require('../../src/main/scheduler.cjs') as {
  availableForJobs: (availableMb: number, reservedHostMb: number) => number
}
const { measuredMemoryGate } = require('../../src/main/lib/scheduler/loadGate.cjs') as {
  measuredMemoryGate: (args: {
    jobBudgetMb: number
    running?: Array<{ agentType: string; rssMb: number }>
    batch?: Array<{ agentType: string }>
    stats: unknown
  }) => { allowed: number; measured: boolean }
}
const { createJobMemoryStats } = require('../../src/main/lib/scheduler/jobMemoryStats.cjs') as {
  createJobMemoryStats: (deps: { storePath: string; now: () => number }) => unknown
}

// A store path that never exists → zero samples → fallback reservations.
const emptyStats = createJobMemoryStats({
  storePath: path.join(os.tmpdir(), `sm-empty-mem-store-${process.pid}-${Date.now()}`, 'none.jsonl'),
  now: () => 1,
})

/** Jobs admitted from a batch of `batchLen`, with `runningCount` jobs whose RSS sums to `consumedMb`. */
function gate(availableMb: number, runningCount: number, batchLen: number, consumedMb = 0): number {
  const perJobRss = runningCount > 0 ? Math.max(0, consumedMb) / runningCount : 0
  const result = measuredMemoryGate({
    jobBudgetMb: availableMb,
    running: Array.from({ length: runningCount }, () => ({ agentType: 'dev-lead', rssMb: perJobRss })),
    batch: Array.from({ length: batchLen }, () => ({ agentType: 'dev-lead' })),
    stats: emptyStats,
  })
  expect(result.measured).toBe(false)
  return result.allowed
}

describe('measuredMemoryGate fallback (empty store = flat 2,500 MB/job)', () => {
  it('passes full batch when memory is ample', () => {
    // 0 running, 3 in batch, 20 GB free → allow all 3
    expect(gate(20_000, 0, 3)).toBe(3)
  })

  it('passes full batch when availableMb is Infinity (non-Linux / fail-open)', () => {
    expect(gate(Infinity, 0, 5)).toBe(5)
  })

  it('allows 0 when even 1 job would exceed threshold (0 running)', () => {
    // need 2500 MB; only 1000 available
    expect(gate(1000, 0, 3)).toBe(0)
  })

  it('allows 0 when running jobs already consume headroom', () => {
    // 3 running, need 2500*4 = 10000 for +1; only 9999 available
    expect(gate(9999, 3, 2)).toBe(0)
  })

  it('clamps batch from 3 to 1 when memory is tight', () => {
    // 0 running; 1 job needs 2500, 2 need 5000 → 3333 allows 1
    expect(gate(3333, 0, 3)).toBe(1)
  })

  it('clamps batch from 2 to 1 when 1 job is already running', () => {
    // 1 running; +1 needs 5000, +2 needs 7500 → 5833 allows 1
    expect(gate(5833, 1, 2)).toBe(1)
  })

  it('passes batch of 0 unchanged (no-op)', () => {
    expect(gate(1000, 0, 0)).toBe(0)
  })

  it('allows exactly at boundary (available === 2500 * slots)', () => {
    // 0 running, batch=2; need 5000; available=5000 → allows 2
    expect(gate(5000, 0, 2)).toBe(2)
  })

  it('one below boundary is clamped', () => {
    expect(gate(4999, 0, 2)).toBe(1)
  })
})

describe('measuredMemoryGate fallback running-RSS credit', () => {
  it('(a) 2 running with consumedMb 0 needs the full 2500 per running job', () => {
    for (const [avail, want] of [[4000, 0], [7500, 1], [9999, 1], [10_000, 2], [12_500, 3]]) {
      expect(gate(avail, 2, 3, 0)).toBe(want)
    }
  })

  it('(b) 1 running with consumedMb 2500 behaves like 0 running', () => {
    for (const avail of [1000, 2500, 4999, 5000, 7500]) {
      expect(gate(avail, 1, 3, 2500)).toBe(gate(avail, 0, 3))
    }
  })

  it('(c) oversized consumedMb never admits more than 0-running would', () => {
    for (const avail of [0, 2499, 2500, 5000, 7500]) {
      expect(gate(avail, 1, 4, 99_999)).toBeLessThanOrEqual(gate(avail, 0, 4))
    }
  })

  it('ignores negative consumedMb', () => {
    expect(gate(2500, 1, 2, -5000)).toBe(gate(2500, 1, 2))
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
    expect(gate(availableForJobs(2038, RESERVE), 0, 3)).toBe(0)
  })

  it('fails open (Infinity) on non-Linux where MemAvailable is unknown', () => {
    expect(availableForJobs(Infinity, RESERVE)).toBe(Infinity)
  })

  it('composed gate: 3 GB reserve + 2.5 GB/job needs ~5.5 GB free to start one job', () => {
    // 5000 MB available → 2000 after reserve → 0 jobs (need 2500 for one)
    expect(gate(availableForJobs(5000, RESERVE), 0, 2)).toBe(0)
    // 5600 MB available → 2600 after reserve → exactly 1 job
    expect(gate(availableForJobs(5600, RESERVE), 0, 2)).toBe(1)
  })
})
