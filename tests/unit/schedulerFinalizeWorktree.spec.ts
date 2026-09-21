/**
 * finalizeJobWorktree / worktreeIntegrationVerdict / guardedTick — the
 * extracted, injectable guards from spawnJob's finally and the maintenance
 * interval (PRD 1372, closing PRD 1358's untested guards). Source:
 * src/main/scheduler.cjs.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  finalizeJobWorktree,
  worktreeIntegrationVerdict,
  guardedTick,
} = require('../../src/main/scheduler.cjs')

const job = { slug: 'demo-slug' }
const worktree = { ok: true, dir: '/tmp/wt', branch: 'sm-job/demo-slug' }

function makeDeps(over: Record<string, unknown> = {}) {
  const jobWorktree = {
    salvageJobWorktreeDiff: vi.fn(async () => ({ ok: true, bytes: 12 })),
    integrateJobBranch: vi.fn(async () => ({ ok: true, integrated: true })),
    cleanupJobWorktree: vi.fn(async (_a: Record<string, unknown>) => undefined),
    ...((over.jobWorktree as object) || {}),
  }
  return {
    uncommittedChanges: vi.fn(async () => ['a.ts']),
    reportSchedulerError: vi.fn(),
    ...over,
    jobWorktree,
  }
}

const run = (deps: ReturnType<typeof makeDeps>) =>
  finalizeJobWorktree({
    job, runDir: '/tmp/run', worktree, guardCwd: '/tmp/main', carriedPaths: [], deps,
  })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('finalizeJobWorktree', () => {
  it('(d) happy path: no failure, cleanup keeps no branch, salvage patch recorded', async () => {
    const deps = makeDeps()
    const r = await run(deps)
    expect(r.worktreeIntegrationFailure).toBeNull()
    expect(r.worktreeLeftoverDirty).toEqual(['a.ts'])
    expect(r.salvagePatch).toBe('/tmp/run/demo-slug.uncommitted.patch')
    expect(deps.jobWorktree.cleanupJobWorktree).toHaveBeenCalledTimes(1)
    expect(deps.jobWorktree.cleanupJobWorktree.mock.calls[0][0]).toMatchObject({ keepBranch: false })
    expect(deps.reportSchedulerError).not.toHaveBeenCalled()
  })

  it('records auto-resolved merge paths', async () => {
    const deps = makeDeps({
      jobWorktree: { integrateJobBranch: vi.fn(async () => ({ ok: true, integrated: true, autoResolved: 'dup', resolvedPaths: ['x'] })) },
    })
    const r = await run(deps)
    expect(r.mergeAutoResolved).toBe('dup')
    expect(r.mergeAutoResolvedPaths).toEqual(['x'])
  })

  it('(e) integration.ok === false: failure = reason, detail = integration, keepBranch true', async () => {
    const integration = { ok: false, reason: 'merge-conflict', failureKind: 'content_conflict', conflictedPaths: ['f'] }
    const deps = makeDeps({ jobWorktree: { integrateJobBranch: vi.fn(async () => integration) } })
    const r = await run(deps)
    expect(r.worktreeIntegrationFailure).toBe('merge-conflict')
    expect(r.worktreeIntegrationDetail).toBe(integration)
    expect(deps.jobWorktree.cleanupJobWorktree.mock.calls[0][0]).toMatchObject({ keepBranch: true })
    expect(deps.reportSchedulerError).not.toHaveBeenCalled()
  })

  it('(a) integrateJobBranch rejects: failure = message, cleanup once keepBranch, sink called, no throw', async () => {
    const deps = makeDeps({ jobWorktree: { integrateJobBranch: vi.fn(async () => { throw new Error('git blew up') }) } })
    const r = await run(deps)
    expect(r.worktreeIntegrationFailure).toBe('git blew up')
    expect(deps.jobWorktree.cleanupJobWorktree).toHaveBeenCalledTimes(1)
    expect(deps.jobWorktree.cleanupJobWorktree.mock.calls[0][0]).toMatchObject({ keepBranch: true })
    expect(deps.reportSchedulerError).toHaveBeenCalledTimes(1)
    expect(deps.reportSchedulerError.mock.calls[0][1]).toBe('demo-slug')
  })

  it('(b) salvageJobWorktreeDiff rejects: same guarantees', async () => {
    const deps = makeDeps({ jobWorktree: { salvageJobWorktreeDiff: vi.fn(async () => { throw new Error('no dir') }) } })
    const r = await run(deps)
    expect(r.worktreeIntegrationFailure).toBe('no dir')
    expect(deps.jobWorktree.cleanupJobWorktree).toHaveBeenCalledTimes(1)
    expect(deps.jobWorktree.cleanupJobWorktree.mock.calls[0][0]).toMatchObject({ keepBranch: true })
    expect(deps.reportSchedulerError).toHaveBeenCalledTimes(1)
  })

  it('(c) cleanupJobWorktree rejects in the happy path AND again in the catch: still no throw', async () => {
    const deps = makeDeps({ jobWorktree: { cleanupJobWorktree: vi.fn(async (_a: Record<string, unknown>) => { throw new Error('rm failed') }) } })
    const r = await run(deps)
    expect(r.worktreeIntegrationFailure).toBe('rm failed')
    expect(deps.jobWorktree.cleanupJobWorktree).toHaveBeenCalledTimes(2)
    expect(deps.reportSchedulerError).toHaveBeenCalledTimes(1)
  })

  it('a non-Error rejection is stringified', async () => {
    const deps = makeDeps({ jobWorktree: { integrateJobBranch: vi.fn(async () => { throw 'plain' }) } })
    expect((await run(deps)).worktreeIntegrationFailure).toBe('plain')
  })
})

describe('worktreeIntegrationVerdict', () => {
  it('null failure -> no override', () => {
    expect(worktreeIntegrationVerdict({ failure: null, detail: null, slug: 's' })).toBeNull()
  })

  it('generic failure -> worktree_integration_failed, downgrade needs_review', () => {
    const v = worktreeIntegrationVerdict({ failure: 'git blew up', detail: null, slug: 's' })
    expect(v).toMatchObject({ verdict: 'worktree_integration_failed', downgradeTo: 'needs_review' })
    expect(v.reason).toContain('worktree branch integration failed: git blew up')
  })

  it('content_conflict uses conflict wording with the paths', () => {
    const v = worktreeIntegrationVerdict({
      failure: 'merge-conflict',
      detail: { failureKind: 'content_conflict', conflictedPaths: ['a.ts', 'b.ts'] },
      slug: 's',
    })
    expect(v.downgradeTo).toBe('needs_review')
    expect(v.reason).toContain('content conflict in a.ts, b.ts')
    expect(v.reason).toContain('sm-job/s')
  })

  it('a rejection inside finalize maps end to end to needs_review, never running', async () => {
    const deps = makeDeps({ jobWorktree: { integrateJobBranch: vi.fn(async () => { throw new Error('boom') }) } })
    const r = await run(deps)
    const v = worktreeIntegrationVerdict({ failure: r.worktreeIntegrationFailure, detail: r.worktreeIntegrationDetail, slug: job.slug })
    expect(v).toMatchObject({ verdict: 'worktree_integration_failed', downgradeTo: 'needs_review' })
  })
})

describe('guardedTick (interval guard)', () => {
  it('a throwing tick is reported once and the next tick still runs', () => {
    vi.useFakeTimers()
    const logs = require('../../src/main/logs.cjs')
    const write = vi.spyOn(logs, 'writeLine').mockImplementation(() => {})
    const fs = require('node:fs')
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {})
    let n = 0
    const second = vi.fn()
    const tick = () => { n += 1; if (n === 1) throw new Error('torn queue.json'); second() }
    const id = setInterval(() => guardedTick(tick, 'rescheduleInterval tick failed'), 1000)
    try {
      vi.advanceTimersByTime(2000)
    } finally {
      clearInterval(id)
      vi.useRealTimers()
    }
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toMatchObject({ message: 'rescheduleInterval tick failed', level: 'error' })
    expect((write.mock.calls[0][0] as { meta: { error: string } }).meta.error).toBe('torn queue.json')
    expect(second).toHaveBeenCalledTimes(1)
  })
})
