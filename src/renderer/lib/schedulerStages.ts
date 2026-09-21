/**
 * schedulerStages — pure derivation layer for the Scheduler 2A redesign:
 * the queue as PLANS (one per weakly-connected wave of an Epic), each split into numbered STAGES
 * (longest-path depth levels of the in-Epic dependsOn DAG).
 *
 * Builds ON TOP of backlogTree (blockers / cycle facts) — it never
 * re-resolves blockers. Plain module, not a store: memoize in the consuming
 * component (a selector returning fresh Plan[] is the React #185 hazard).
 *
 * ETA note: SchedulePanel's computeEtaMap is a private, per-row, status-kind
 * aware formatter over a different shape (aheadIndex Map + StatusKind), so it
 * is intentionally NOT forked/extracted here; the plan-level ETA below is a
 * separate remaining-work estimate. SchedulePanel is left untouched.
 *
 * Complexity: O(V log V + E) overall — grouping, one memoized DFS per plan for
 * depth, sorts per stage. No nested loops over user-scaled data.
 */
import type { ScheduleJob } from '../../preload/api'
import type { PromptSession } from '../state/promptSessions'
import { buildBacklogTree, flattenBacklogNodes, type BacklogBlocker } from './backlogTree'
import { splitTitleAndGoal } from './epicDerive'
import { prdNumber } from '../components/tabs/scheduler/sched-primitives'

export type PlanStatus = 'active' | 'queued' | 'done' | 'draft'
export type StageState = 'done' | 'running' | 'held' | 'blocked' | 'pending'
export type RowKind =
  | 'done' | 'running' | 'next' | 'eta' | 'retry' | 'dep' | 'failed' | 'review' | 'gate' | 'quarantined'

export interface PlanOpts {
  /** promptSessions store's sessions — Epic labels. */
  sessions: Record<string, PromptSession>
  /** Clock for elapsed / ETA maths. Defaults to Date.now(). */
  now?: number
  /** Mean completed-job duration; derived from `jobs` when omitted. */
  avgDurationMs?: number
  /** Parallel slots assumed for ETA maths. Defaults to 1 (conservative). */
  concurrency?: number
}

export interface PlanRow {
  slug: string
  title: string
  status: string
  /** 1-based stage number within the plan. */
  stage: number
  /** Leading PRD number ('284'), or null. */
  prdNumber: string | null
  rowKind: RowKind
  /** The design's right-cell string ('4m12s', '62%', 'next', '~2m', '1 retry', '←284', …). */
  rowTrailing: string
  cycle: boolean
  estimateMinutes: number | null
  /** dependsOn entries that live in this same Epic (the edges used for staging). */
  deps: string[]
  /** dependsOn entries in OTHER Epics — ignored for staging, still reported. */
  crossEpicDeps: string[]
  blockers: BacklogBlocker[]
  job: ScheduleJob
}

export interface Stage {
  n: number
  state: StageState
  /** Right-aligned mono string: '9/9 done', '2 running · 14', '21 held', '18 blocked'. */
  summary: string
  rows: PlanRow[]
  doneCount: number
  runningCount: number
  heldCount: number
  blockedCount: number
}

export interface Plan {
  epicId: string | null
  /** 1-based wave ordinal within the Epic (components ordered by lowest PRD number). */
  waveIndex: number
  /** 1-based, stable: ordered by first-PRD slug number ascending, ties by epicId. */
  index: number
  label: string
  status: PlanStatus
  prdCount: number
  stageCount: number
  doneCount: number
  runningCount: number
  heldCount: number
  blockedCount: number
  /** Remaining-work estimate in ms (0 when nothing is left). */
  etaMs: number
  /** COMPLETE list of stages 1..stageCount — windowing is the UI's job. */
  stages: Stage[]
}

export interface QueueSummary {
  readyNow: number
  totalQueued: number
  heldByDeps: number
  needsYou: number
  needsYouStage: number | null
  failedCount: number
  needsReviewCount: number
  doneToday: number
  inFlight: number
}

const DEFAULT_AVG_MS = 150_000

const isDone = (s: string) => s === 'completed' || s === 'skipped'
const isRunning = (s: string) => s === 'running' || s === 'investigating'
const isAttention = (s: string) => s === 'failed' || s === 'needs_review' || s === 'quarantined'
const isStuckBlocker = (s: string | null) => s === 'failed' || s === 'needs_review' || s === 'quarantined'

/** '4m12s' / '42s' / '1h05m'. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** '~now' / '~42s' / '~2m' / '~3h18m'. */
export function formatEta(ms: number): string {
  if (ms <= 5_000) return '~now'
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `~${mins}m`
  return `~${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`
}

/** A running row's right cell: '62%' when it has an estimate, else '4m12s'. Exported so the
 *  live per-second tick in PrdRow reuses this instead of forking the formula. */
export function runningTrailing(j: ScheduleJob, elapsedMs: number): string {
  const est = j.estimateMinutes ? j.estimateMinutes * 60_000 : null
  return est ? `${Math.min(99, Math.floor((elapsedMs / est) * 100))}%` : formatElapsed(elapsedMs)
}

function averageDurationMs(jobs: ScheduleJob[]): number {
  let sum = 0
  let n = 0
  for (const j of jobs) {
    if (j.status === 'completed' && j.startedAt && j.finishedAt) {
      const d = Date.parse(j.finishedAt) - Date.parse(j.startedAt)
      if (d > 0) { sum += d; n++ }
    }
  }
  return n === 0 ? DEFAULT_AVG_MS : sum / n
}

function numOf(slug: string): number {
  const n = prdNumber(slug)
  return n === null ? Infinity : Number(n)
}

/** Dispatch priority: lower PRD number first, then slug. */
function byPriority(a: { slug: string }, b: { slug: string }): number {
  const d = numOf(a.slug) - numOf(b.slug)
  if (d !== 0 && !Number.isNaN(d)) return d
  return a.slug.localeCompare(b.slug)
}

function retryCount(j: ScheduleJob): number {
  let n = 0
  for (const h of j.statusHistory ?? []) if (h.to === 'pending' && h.from !== null) n++
  return n
}

interface Classified { kind: RowKind; trailing: string; held: boolean; blocked: boolean }

function planStatusOf(rows: PlanRow[]): PlanStatus {
  if (rows.some((r) => isRunning(r.status))) return 'active'
  if (rows.every((r) => isDone(r.status))) return 'done'
  const nonQuarantined = rows.filter((r) => r.status !== 'quarantined').length
  // "every row quarantined" — which also covers "zero edges AND zero non-quarantined rows".
  if (nonQuarantined === 0) return 'draft'
  return 'queued'
}

function stageSummary(state: StageState, s: Omit<Stage, 'summary' | 'state'>, pendingCount: number, attention: number): string {
  switch (state) {
    case 'done': return `${s.doneCount}/${s.rows.length} done`
    case 'running': return `${s.runningCount} running · ${pendingCount}`
    case 'held': return `${s.heldCount} held`
    case 'blocked': return `${s.blockedCount + attention} blocked`
    default: return `${pendingCount} ready`
  }
}

function byFirst(a: { _firstNum: number; _firstSlug: string }, b: { _firstNum: number; _firstSlug: string }): number {
  if (a._firstNum !== b._firstNum) return a._firstNum < b._firstNum ? -1 : 1
  return a._firstSlug.localeCompare(b._firstSlug)
}

/**
 * Weakly-connected components of one Epic's rows over the in-Epic dependsOn edges (cross-Epic
 * and dangling edges are ignored, so they never merge or spawn waves). Union-find with path
 * halving: near O(V+E). Cyclic rows are just edges here, so a cycle lands in one component.
 * Deterministic: components emit in first-seen node order.
 */
function weakComponents<N extends { row: { slug: string; dependsOn?: string[] | null } }>(
  nodes: N[],
  inEpic: Set<string>,
): N[][] {
  const parent = new Map<string, string>(nodes.map((n) => [n.row.slug, n.row.slug]))
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!)
      x = parent.get(x)!
    }
    return x
  }
  for (const n of nodes) {
    for (const d of n.row.dependsOn ?? []) {
      if (inEpic.has(d)) parent.set(find(n.row.slug), find(d))
    }
  }
  const groups = new Map<string, N[]>()
  for (const n of nodes) {
    const r = find(n.row.slug)
    const g = groups.get(r)
    if (g) g.push(n)
    else groups.set(r, [n])
  }
  return [...groups.values()]
}

/**
 * Groups `jobs` into Plans (one per weakly-connected wave of an Epic) with complete Stage lists.
 * Cross-Epic dependsOn edges never affect staging. Cycle members get
 * (max depth of their non-cycle predecessors) + 1 and `cycle: true`.
 */
export function buildPlans(jobs: ScheduleJob[], opts: PlanOpts): Plan[] {
  if (jobs.length === 0) return []
  const now = opts.now ?? Date.now()
  const avgMs = opts.avgDurationMs ?? averageDurationMs(jobs)
  const conc = Math.max(1, opts.concurrency ?? 1)
  const bySlug = new Map(jobs.map((j) => [j.slug, j]))

  // Global ETA position: ready pending rows in dispatch order.
  const ready = (j: ScheduleJob) =>
    j.status === 'pending' && (j.dependsOn ?? []).every((d) => bySlug.get(d) === undefined || bySlug.get(d)!.status === 'completed')
  const aheadIdx = new Map<string, number>()
  jobs.filter(ready).sort(byPriority).forEach((j, i) => aheadIdx.set(j.slug, i))

  const sections = buildBacklogTree(jobs, opts.sessions, jobs)
  const plans: Array<Plan & { _firstNum: number; _firstSlug: string }> = []

  for (const section of sections) {
    const allNodes = flattenBacklogNodes(section.nodes)
    const inEpic = new Set(allNodes.map((n) => n.row.slug))
    const nodeBySlug = new Map(allNodes.map((n) => [n.row.slug, n]))
    const sectionPlans: Array<Plan & { _firstNum: number; _firstSlug: string }> = []
    for (const nodes of weakComponents(allNodes, inEpic)) {

      // ── stage depth: memoized DFS; cyclic rows ignore edges to other cyclic rows.
      const depth = new Map<string, number>()
      const inProgress = new Set<string>()
      const depsOf = (slug: string): string[] => {
        const node = nodeBySlug.get(slug)!
        return (node.row.dependsOn ?? []).filter((d) => inEpic.has(d) && !(node.cycle && nodeBySlug.get(d)!.cycle))
      }
      const depthOf = (slug: string): number => {
        const memo = depth.get(slug)
        if (memo !== undefined) return memo
        if (inProgress.has(slug)) return 0 // belt-and-suspenders: never hang
        inProgress.add(slug)
        let max = 0
        for (const d of depsOf(slug)) max = Math.max(max, depthOf(d))
        inProgress.delete(slug)
        depth.set(slug, max + 1)
        return max + 1
      }
      for (const n of nodes) {
        depthOf(n.row.slug)
      }

      const rows: PlanRow[] = nodes.map((n) => {
        const j = n.row
        const deps = (j.dependsOn ?? []).filter((d) => inEpic.has(d))
        return {
          slug: j.slug,
          title: j.title,
          status: j.status,
          stage: depth.get(j.slug)!,
          prdNumber: prdNumber(j.slug),
          rowKind: 'dep',
          rowTrailing: '',
          cycle: n.cycle,
          estimateMinutes: j.estimateMinutes ?? null,
          deps,
          crossEpicDeps: (j.dependsOn ?? []).filter((d) => !inEpic.has(d)),
          blockers: n.blockers,
          job: j,
        }
      })
      rows.sort(byPriority)
      const stageCount = rows.reduce((m, r) => Math.max(m, r.stage), 0)

      // ── per-row classification
      const cls = new Map<string, Classified>()
      for (const r of rows) {
        const j = r.job
        const node = nodeBySlug.get(r.slug)!
        const s = j.status
        let c: Classified
        if (isDone(s)) {
          const d = j.startedAt && j.finishedAt ? Date.parse(j.finishedAt) - Date.parse(j.startedAt) : NaN
          c = { kind: 'done', trailing: d > 0 ? formatElapsed(d) : '', held: false, blocked: false }
        } else if (isRunning(s)) {
          const el = j.startedAt ? Math.max(0, now - Date.parse(j.startedAt)) : null
          c = { kind: 'running', trailing: el === null ? '' : runningTrailing(j, el), held: false, blocked: false }
        } else if (s === 'failed') c = { kind: 'failed', trailing: 'failed', held: false, blocked: false }
        else if (s === 'needs_review') c = { kind: 'review', trailing: 'review', held: false, blocked: false }
        else if (s === 'quarantined') c = { kind: 'quarantined', trailing: 'quarantined', held: false, blocked: false }
        else {
          const unmet = node.blockers.filter((b) => !b.missing && b.status !== 'completed')
          if (unmet.length > 0) {
            const stuck = unmet.some((b) => isStuckBlocker(b.status))
            const first = unmet[0].slug
            c = { kind: 'dep', trailing: `←${prdNumber(first) ?? first}`, held: !stuck, blocked: stuck }
          } else if (j.heldReason) {
            c = { kind: 'gate', trailing: 'gate', held: true, blocked: false }
          } else {
            const retries = retryCount(j)
            const idx = aheadIdx.get(j.slug) ?? 0
            c = retries > 0
              ? { kind: 'retry', trailing: `${retries} ${retries === 1 ? 'retry' : 'retries'}`, held: false, blocked: false }
              : { kind: 'eta', trailing: formatEta((idx * avgMs) / conc), held: false, blocked: false }
          }
        }
        cls.set(r.slug, c)
      }

      // ── stages (+ exactly one 'next' per stage: highest-priority dispatchable pending row)
      const stages: Stage[] = []
      for (let n = 1; n <= stageCount; n++) {
        const srows = rows.filter((r) => r.stage === n) // already priority-sorted
        const next = srows.find((r) => {
          const k = cls.get(r.slug)!.kind
          return r.status === 'pending' && (k === 'eta' || k === 'retry')
        })
        if (next) { const c = cls.get(next.slug)!; c.kind = 'next'; c.trailing = 'next' }
        let doneCount = 0, runningCount = 0, heldCount = 0, blockedCount = 0, pendingCount = 0, attention = 0
        for (const r of srows) {
          const c = cls.get(r.slug)!
          r.rowKind = c.kind
          r.rowTrailing = c.trailing
          if (isDone(r.status)) doneCount++
          else if (isRunning(r.status)) runningCount++
          else if (r.status === 'pending') {
            pendingCount++
            if (c.held) heldCount++
            if (c.blocked) blockedCount++
          } else if (isAttention(r.status)) attention++
        }
        const state: StageState =
          doneCount === srows.length ? 'done'
            : runningCount > 0 ? 'running'
              : blockedCount + attention > 0 ? 'blocked'
                : heldCount > 0 ? 'held'
                  : 'pending'
        const base = { n, rows: srows, doneCount, runningCount, heldCount, blockedCount }
        stages.push({ ...base, state, summary: stageSummary(state, base, pendingCount, attention) })
      }

      // ── plan-level ETA: serial remaining work / concurrency
      let remaining = 0
      for (const r of rows) {
        const est = r.estimateMinutes ? r.estimateMinutes * 60_000 : avgMs
        if (r.status === 'pending') remaining += est
        else if (isRunning(r.status)) {
          const el = r.job.startedAt ? Math.max(0, now - Date.parse(r.job.startedAt)) : 0
          remaining += Math.max(0, est - el)
        }
      }

      const firstNum = rows.reduce((m, r) => Math.min(m, numOf(r.slug)), Infinity)
      sectionPlans.push({
        epicId: section.epicId,
        waveIndex: 0,
        index: 0,
        // A known Epic's goalText is `${title}\n\n${goal}` — the plan header shows just the human title.
        label: section.known ? splitTitleAndGoal(section.label).title : section.label,
        status: planStatusOf(rows),
        prdCount: rows.length,
        stageCount,
        doneCount: stages.reduce((a, s) => a + s.doneCount, 0),
        runningCount: stages.reduce((a, s) => a + s.runningCount, 0),
        heldCount: stages.reduce((a, s) => a + s.heldCount, 0),
        blockedCount: stages.reduce((a, s) => a + s.blockedCount, 0),
        etaMs: remaining / conc,
        stages,
        _firstNum: firstNum,
        _firstSlug: rows[0].slug,
      })
    }

    // Wave ordinal: components ordered by lowest PRD number (ties: first slug). The label only
    // shows the wave when the Epic really has more than one plan.
    sectionPlans.sort(byFirst)
    sectionPlans.forEach((p, i) => {
      p.waveIndex = i + 1
      if (sectionPlans.length > 1) p.label = `${p.label} · plan ${i + 1}/${sectionPlans.length}`
      plans.push(p)
    })
  }

  plans.sort((a, b) => {
    if (a._firstNum !== b._firstNum) return a._firstNum < b._firstNum ? -1 : 1
    const e = (a.epicId ?? '').localeCompare(b.epicId ?? '')
    return e !== 0 ? e : a.waveIndex - b.waveIndex
  })
  return plans.map(({ _firstNum, _firstSlug, ...p }, i) => ({ ...p, index: i + 1 }))
}

/** KPI-band aggregates. `now` only anchors "done today" (local calendar day). */
export function summarizeQueue(jobs: ScheduleJob[], now: number = Date.now()): QueueSummary {
  const bySlug = new Map(jobs.map((j) => [j.slug, j]))
  const today = new Date(now).toDateString()
  let readyNow = 0, totalQueued = 0, failedCount = 0, needsReviewCount = 0, quarantined = 0, doneToday = 0, inFlight = 0
  for (const j of jobs) {
    if (j.status === 'pending') {
      totalQueued++
      const d = j.dependsOn ?? []
      if (d.every((s) => bySlug.get(s) === undefined || bySlug.get(s)!.status === 'completed')) readyNow++
    } else if (isRunning(j.status)) inFlight++
    else if (j.status === 'failed') failedCount++
    else if (j.status === 'needs_review') needsReviewCount++
    else if (j.status === 'quarantined') quarantined++
    else if (j.status === 'completed' && j.finishedAt && new Date(Date.parse(j.finishedAt)).toDateString() === today) doneToday++
  }
  let needsYouStage: number | null = null
  if (failedCount + needsReviewCount + quarantined > 0) {
    for (const p of buildPlans(jobs, { sessions: {}, now })) {
      for (const s of p.stages) {
        if (s.rows.some((r) => isAttention(r.status))) {
          if (needsYouStage === null || s.n < needsYouStage) needsYouStage = s.n
          break
        }
      }
    }
  }
  return {
    readyNow,
    totalQueued,
    heldByDeps: totalQueued - readyNow,
    needsYou: failedCount + needsReviewCount + quarantined,
    needsYouStage,
    failedCount,
    needsReviewCount,
    doneToday,
    inFlight,
  }
}

/**
 * Longest in-Epic dependsOn chain (dependency-first slugs). Ties: summed
 * estimateMinutes (null = 0) desc, then lexicographically smallest chain.
 * Uses the same edge set as staging, so cycles cannot hang it. O(V+E).
 */
export function criticalPath(plan: Plan): string[] {
  const rows = new Map<string, PlanRow>()
  for (const s of plan.stages) for (const r of s.rows) rows.set(r.slug, r)
  const cyc = (slug: string) => rows.get(slug)?.cycle === true
  type Best = { chain: string[]; est: number }
  const memo = new Map<string, Best>()
  const inProgress = new Set<string>()
  const better = (a: Best, b: Best): boolean => {
    if (a.chain.length !== b.chain.length) return a.chain.length > b.chain.length
    if (a.est !== b.est) return a.est > b.est
    return a.chain.join('\0') < b.chain.join('\0')
  }
  const visit = (slug: string): Best => {
    const hit = memo.get(slug)
    if (hit) return hit
    const r = rows.get(slug)!
    const self = r.estimateMinutes ?? 0
    if (inProgress.has(slug)) return { chain: [slug], est: self }
    inProgress.add(slug)
    let best: Best | null = null
    for (const d of r.deps) {
      if (!rows.has(d) || (r.cycle && cyc(d))) continue
      const cand = visit(d)
      if (!best || better(cand, best)) best = cand
    }
    inProgress.delete(slug)
    const out: Best = best
      ? { chain: [...best.chain, slug], est: best.est + self }
      : { chain: [slug], est: self }
    memo.set(slug, out)
    return out
  }
  let overall: Best | null = null
  for (const slug of rows.keys()) {
    const b = visit(slug)
    if (!overall || better(b, overall)) overall = b
  }
  return overall ? overall.chain : []
}
