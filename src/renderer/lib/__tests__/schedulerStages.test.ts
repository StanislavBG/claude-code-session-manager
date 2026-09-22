import { describe, it, expect } from 'vitest'
import type { ScheduleJob } from '../../../preload/api'
import { buildPlans, summarizeQueue, criticalPath, formatElapsed, formatEta } from '../schedulerStages'

const NOW = Date.parse('2026-09-19T12:00:00Z')
let seq = 0
function job(slug: string, o: Partial<ScheduleJob> & Record<string, unknown> = {}): ScheduleJob {
  seq++
  return {
    slug, title: slug, cwd: '/p', parallelGroup: seq, estimateMinutes: null, bodyPreview: '',
    status: 'pending', runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null,
    dependsOn: [], epicId: 'e1', ...o,
  } as unknown as ScheduleJob
}
const plans = (jobs: ScheduleJob[]) => buildPlans(jobs, { sessions: {}, now: NOW, avgDurationMs: 120_000 })
const p1 = (jobs: ScheduleJob[]) => plans(jobs)[0]
const row = (jobs: ScheduleJob[], slug: string) => plans(jobs).flatMap((p) => p.stages.flatMap((s) => s.rows)).find((r) => r.slug === slug)!
/** Rows of one Epic that share no dependsOn edge are separate WAVES (plans); `hub` is a completed root they all hang off, so they form ONE plan (stage 1 = hub, fixture rows start at stage 2). */
const hub = (...js: ScheduleJob[]) => [job('0-hub', { status: 'completed' }), ...js.map((j) => ((j.dependsOn as string[]).length === 0 ? { ...j, dependsOn: ['0-hub'] } : j))]

describe('buildPlans basics', () => {
  it('empty input → no plans', () => { expect(plans([])).toEqual([]) })
  it('single row', () => {
    const p = p1([job('1-a')])
    expect(p.prdCount).toBe(1); expect(p.stageCount).toBe(1); expect(p.index).toBe(1)
    expect(p.stages[0].rows[0].rowKind).toBe('next')
  })
  it('one plan per epic, indexed by last (highest) PRD number descending, then epicId', () => {
    const ps = plans([job('30-a', { epicId: 'b' }), job('10-x', { epicId: 'z' }), job('10-y', { epicId: 'c' })])
    expect(ps.map((p) => [p.epicId, p.index])).toEqual([['b', 1], ['c', 2], ['z', 3]])
  })
  it('newest-first: cross-plan order is by each plan\'s HIGHEST PRD number descending, not lowest', () => {
    // plan A = 1001,1050 · plan B = 1020 · plan C = 1030,1090 → order C, A, B (max: 1090, 1050, 1020)
    const ps = plans([
      job('1001-a', { epicId: 'A' }), job('1050-a2', { epicId: 'A', dependsOn: ['1001-a'] }),
      job('1020-b', { epicId: 'B' }),
      job('1030-c', { epicId: 'C' }), job('1090-c2', { epicId: 'C', dependsOn: ['1030-c'] }),
    ])
    expect(ps.map((p) => p.epicId)).toEqual(['C', 'A', 'B'])
    // waveIndex within an Epic is unaffected — still ascending by first-PRD number.
    for (const p of ps) expect(p.waveIndex).toBe(1)
  })
  it('waveIndex within a multi-wave Epic stays ascending even though the wave with the higher PRD number sorts first at the top level', () => {
    // Epic D has two independent waves: wave 1 = 100-d1 (older), wave 2 = 200-d2 (newer/appended-later).
    const ps = plans([job('100-d1', { epicId: 'D' }), job('200-d2', { epicId: 'D' })])
    const byWave = new Map(ps.map((p) => [p.waveIndex, p]))
    expect(byWave.get(1)!.prdCount).toBe(1)
    expect(byWave.get(2)!.prdCount).toBe(1)
    // Top level: the wave carrying the higher PRD number (200-d2, wave 2) sorts first.
    expect(ps[0].waveIndex).toBe(2)
    expect(ps[1].waveIndex).toBe(1)
  })
  it('uses session label when the epic resolves', () => {
    const ps = buildPlans([job('1-a')], { sessions: { e1: { goalText: 'starry-night' } as never }, now: NOW })
    expect(ps[0].label).toBe('starry-night')
  })
})

describe('Plan.status', () => {
  it('active when a row is running or investigating', () => {
    expect(p1(hub(job('1-a', { status: 'investigating' }), job('2-b'))).status).toBe('active')
    expect(p1([job('1-a', { status: 'running' })]).status).toBe('active')
  })
  it('done when all completed/skipped', () => {
    expect(p1(hub(job('1-a', { status: 'completed' }), job('2-b', { status: 'skipped' }))).status).toBe('done')
  })
  it('draft when every row is quarantined', () => {
    expect(p1([job('0-hub', { status: 'quarantined' }), job('1-a', { status: 'quarantined', dependsOn: ['0-hub'] }), job('2-b', { status: 'quarantined', dependsOn: ['0-hub'] })]).status).toBe('draft')
  })
  it('queued otherwise', () => {
    expect(p1([job('1-a'), job('2-b', { dependsOn: ['1-a'] })]).status).toBe('queued')
    // 2-b (own wave, higher PRD number) sorts before 1-a — newest-first.
    expect(plans([job('1-a', { status: 'completed' }), job('2-b')]).map((p) => p.status)).toEqual(['queued', 'done'])
  })
})

describe('stage depth', () => {
  it('longest-path depth, roots are stage 1', () => {
    const js = [job('1-a'), job('2-b', { dependsOn: ['1-a'] }), job('3-c', { dependsOn: ['1-a', '2-b'] }), job('4-d')]
    expect([1, 2, 3, 4].map((n) => row(js, ['1-a', '2-b', '3-c', '4-d'][n - 1]).stage)).toEqual([1, 2, 3, 1])
    // 4-d is its own (single-row) wave with the higher PRD number, so it sorts first.
    const ps = plans(js)
    expect(ps.map((p) => p.prdCount)).toEqual([1, 3])
    expect(ps[1].stageCount).toBe(3)
    expect(ps[1].stages.map((s) => s.n)).toEqual([1, 2, 3])
  })
  it('cross-epic edges ignored for staging but reported', () => {
    const js = [job('1-a', { epicId: 'x' }), job('2-b', { epicId: 'y', dependsOn: ['1-a'] })]
    const ps = plans(js)
    const b = ps.flatMap((p) => p.stages.flatMap((s) => s.rows)).find((r) => r.slug === '2-b')!
    expect(b.stage).toBe(1); expect(b.crossEpicDeps).toEqual(['1-a']); expect(b.blockers[0].slug).toBe('1-a')
  })
  it('2-cycle: no hang, members at max pred depth + 1, flagged', () => {
    const js = [job('1-p'), job('2-a', { dependsOn: ['1-p', '3-b'] }), job('3-b', { dependsOn: ['2-a'] }), job('4-z', { dependsOn: ['3-b'] })]
    expect(row(js, '2-a')).toMatchObject({ stage: 2, cycle: true })
    expect(row(js, '3-b')).toMatchObject({ stage: 1, cycle: true }) // no non-cycle predecessor → 1
    expect(row(js, '4-z')).toMatchObject({ stage: 2, cycle: false })
  })
  it('3-cycle with no outside predecessors', () => {
    const js = [job('1-a', { dependsOn: ['3-c'] }), job('2-b', { dependsOn: ['1-a'] }), job('3-c', { dependsOn: ['2-b'] })]
    for (const s of ['1-a', '2-b', '3-c']) expect(row(js, s)).toMatchObject({ stage: 1, cycle: true })
  })
})

describe('Stage.state / summary', () => {
  it('done', () => {
    const s = p1(hub(job('1-a', { status: 'completed' }), job('2-b', { status: 'skipped' }))).stages[1]
    expect(s.state).toBe('done'); expect(s.summary).toBe('2/2 done')
  })
  it('running', () => {
    const js = hub(job('1-a', { status: 'running' }), job('2-b'), job('3-c'), job('4-d'))
    const s = p1(js).stages[1]
    expect(s.state).toBe('running'); expect(s.summary).toBe('1 running · 3')
  })
  it('held: rows waiting on healthy deps', () => {
    const js = [job('1-a', { status: 'running' }), job('2-b', { dependsOn: ['1-a'] }), job('3-c', { dependsOn: ['1-a'] })]
    const s = p1(js).stages[1]
    expect(s.state).toBe('held'); expect(s.summary).toBe('2 held')
  })
  it('blocked: dependency failed', () => {
    const js = [job('1-a', { status: 'failed' }), job('2-b', { dependsOn: ['1-a'] })]
    const s = p1(js).stages[1]
    expect(s.state).toBe('blocked'); expect(s.summary).toBe('1 blocked')
    expect(p1(js).blockedCount).toBe(1)
  })
  it('pending: ready rows only', () => {
    const s = p1(hub(job('1-a'), job('2-b'))).stages[1]
    expect(s.state).toBe('pending'); expect(s.summary).toBe('2 ready')
  })
})

describe('row kinds / trailing', () => {
  it('done shows duration; running shows percent with estimate, elapsed without', () => {
    const start = new Date(NOW - 252_000).toISOString()
    const js = hub(
      job('1-a', { status: 'completed', startedAt: new Date(NOW - 300_000).toISOString(), finishedAt: start }),
      job('2-b', { status: 'running', startedAt: start }),
      job('3-c', { status: 'running', startedAt: start, estimateMinutes: 7 }),
    )
    expect(row(js, '1-a')).toMatchObject({ rowKind: 'done', rowTrailing: '48s' })
    expect(row(js, '2-b')).toMatchObject({ rowKind: 'running', rowTrailing: '4m12s' })
    expect(row(js, '3-c')).toMatchObject({ rowKind: 'running', rowTrailing: '60%' })
  })
  it('next goes to exactly one row per stage; others get eta', () => {
    const js = hub(job('1-a'), job('2-b'), job('3-c'))
    const kinds = p1(js).stages[1].rows.map((r) => r.rowKind)
    expect(kinds).toEqual(['next', 'eta', 'eta'])
    expect(row(js, '1-a').rowTrailing).toBe('next')
    expect(row(js, '2-b').rowTrailing).toBe('~2m')
  })
  it('retry, dep, gate, failed, review, quarantined', () => {
    const hist = [{ from: 'failed', to: 'pending', reason: null, source: null, at: '' }]
    const js = hub(
      job('1-a', { status: 'running' }),
      job('2-b'), // next
      job('3-c', { statusHistory: hist }),
      job('4-d', { dependsOn: ['1-a'] }),
      job('5-e', { heldReason: 'circuit' }),
      job('6-f', { status: 'failed' }),
      job('7-g', { status: 'needs_review' }),
      job('8-h', { status: 'quarantined' }),
    )
    expect(row(js, '3-c')).toMatchObject({ rowKind: 'retry', rowTrailing: '1 retry' })
    expect(row(js, '2-b').rowKind).toBe('next')
    expect(row(js, '4-d')).toMatchObject({ rowKind: 'dep', rowTrailing: '←1' })
    expect(row(js, '5-e')).toMatchObject({ rowKind: 'gate', rowTrailing: 'gate' })
    expect(row(js, '6-f').rowKind).toBe('failed')
    expect(row(js, '7-g')).toMatchObject({ rowKind: 'review', rowTrailing: 'review' })
    expect(row(js, '8-h').rowKind).toBe('quarantined')
  })
  it('a gated/dep-blocked row is never "next"', () => {
    const js = [job('1-a', { heldReason: 'x' }), job('2-b', { dependsOn: ['1-a'] })]
    expect(p1(js).stages.flatMap((s) => s.rows).some((r) => r.rowKind === 'next')).toBe(false)
  })
})

describe('plan counters + eta', () => {
  it('counts and etaMs', () => {
    const js = [job('1-a', { status: 'completed' }), job('2-b', { status: 'running', startedAt: new Date(NOW - 60_000).toISOString(), estimateMinutes: 5, dependsOn: ['1-a'] }), job('3-c', { dependsOn: ['2-b'], estimateMinutes: 10 })]
    const p = p1(js)
    expect(p).toMatchObject({ prdCount: 3, doneCount: 1, runningCount: 1, heldCount: 1, blockedCount: 0 })
    expect(p.etaMs).toBe(4 * 60_000 + 10 * 60_000)
  })
})

describe('summarizeQueue', () => {
  it('aggregates', () => {
    const js = [
      job('1-a', { status: 'completed', finishedAt: new Date(NOW - 1000).toISOString() }),
      job('2-b', { status: 'running' }),
      job('3-c'),
      job('4-d', { dependsOn: ['2-b'] }),
      job('5-e', { status: 'failed' }),
      job('6-f', { status: 'needs_review', dependsOn: ['5-e'] }),
      job('7-g', { status: 'quarantined' }),
    ]
    expect(summarizeQueue(js, NOW)).toEqual({
      readyNow: 1, totalQueued: 2, heldByDeps: 1, needsYou: 3, needsYouStage: 1,
      failedCount: 1, needsReviewCount: 1, doneToday: 1, inFlight: 1,
    })
  })
  it('needsYouStage is the lowest stage with an attention row; null when none', () => {
    const js = [job('1-a'), job('2-b', { dependsOn: ['1-a'] }), job('3-c', { status: 'failed', dependsOn: ['2-b'] })]
    expect(summarizeQueue(js, NOW).needsYouStage).toBe(3)
    expect(summarizeQueue([job('1-a')], NOW).needsYouStage).toBeNull()
  })
  it('empty', () => {
    expect(summarizeQueue([], NOW)).toMatchObject({ readyNow: 0, totalQueued: 0, needsYou: 0, needsYouStage: null })
  })
})

describe('criticalPath', () => {
  it('longest chain', () => {
    const js = [job('1-a'), job('2-b', { dependsOn: ['1-a'] }), job('3-c', { dependsOn: ['2-b'] }), job('4-d', { dependsOn: ['1-a'] })]
    expect(criticalPath(p1(js))).toEqual(['1-a', '2-b', '3-c'])
  })
  it('ties broken by summed estimate, then slug', () => {
    const est = [job('1-a'), job('2-b', { dependsOn: ['1-a'], estimateMinutes: 5 }), job('3-c', { dependsOn: ['1-a'], estimateMinutes: 9 })]
    expect(criticalPath(p1(est))).toEqual(['1-a', '3-c'])
    const tie = [job('1-a'), job('3-c', { dependsOn: ['1-a'] }), job('2-b', { dependsOn: ['1-a'] })]
    expect(criticalPath(p1(tie))).toEqual(['1-a', '2-b'])
  })
  it('survives cycles', () => {
    const js = [job('1-a', { dependsOn: ['2-b'] }), job('2-b', { dependsOn: ['1-a'] })]
    expect(criticalPath(p1(js)).length).toBeGreaterThan(0)
  })
})

describe('formatters', () => {
  it('elapsed / eta', () => {
    expect(formatElapsed(252_000)).toBe('4m12s'); expect(formatElapsed(3_900_000)).toBe('1h05m')
    expect(formatEta(1000)).toBe('~now'); expect(formatEta(120_000)).toBe('~2m'); expect(formatEta(11_880_000)).toBe('~3h18m')
  })
})

describe('buildPlans planId grouping', () => {
  it('groups by explicit planId even when the dependsOn graph would connect them', () => {
    const ps = plans([
      job('1-a', { planId: 'pl-1' }),
      job('2-b', { planId: 'pl-1', dependsOn: ['1-a'] }),
      job('3-c', { planId: 'pl-2', dependsOn: ['2-b'] }),
    ])
    // pl-2 (single row, max PRD number 3) sorts before pl-1 (max PRD number 2) — newest-first.
    expect(ps.map((p) => p.prdCount)).toEqual([1, 2])
    expect(ps[0].stages.map((s) => s.n)).toEqual([1])
  })
  it('a mixed section (some rows lack planId) falls back to derivation with no dup/dropped rows', () => {
    const ps = plans([
      job('1-a', { planId: 'pl-1' }),
      job('2-b', { dependsOn: ['1-a'] }),
      job('3-c'),
    ])
    const slugs = ps.flatMap((p) => p.stages.flatMap((s) => s.rows.map((r) => r.slug))).sort()
    expect(slugs).toEqual(['1-a', '2-b', '3-c'])
    expect(ps.map((p) => p.prdCount).sort()).toEqual([1, 2])
  })
  it('legacy fixture without planId keeps connected-component waves', () => {
    const ps = plans([job('1-a'), job('2-b', { dependsOn: ['1-a'] }), job('3-c')])
    expect(ps.map((p) => p.prdCount).sort()).toEqual([1, 2])
  })
})
