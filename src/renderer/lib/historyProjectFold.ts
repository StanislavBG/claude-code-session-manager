/**
 * historyProjectFold.ts — applies the "a PROJECT is a CWD" rule
 * (lib/knownProjectAggregate.ts) to the History analytics payload.
 *
 * `history:dashboard` keys every `byProject` row by the encoded
 * `~/.claude/projects/<dir>` folder name (historyAggregator.cjs buckets on
 * `encodedCwd`), which is a TRANSCRIPT STORE identity, not a project one.
 * On this machine that made History's project axis report 2028 projects —
 * 2009 of them `-tmp-sm-paged-test-*` / `-tmp-sm-doflush-test-*` fixture
 * folders left behind by this repo's own tests. They carry zero tokens and
 * zero spend but 4,304 sessions between them, so the `sessions` measure, the
 * project count, the facet chips and the concentration panel were all wrong,
 * and every label rendered as the raw encoded slug because
 * `projectNameFromCwd` has no `/` to split on.
 *
 * This folds the days by resolved cwd instead. Two folders that resolve to
 * one working directory merge into a single project row.
 *
 * NOTHING IS SILENTLY DROPPED. A key that resolves to no real cwd is removed
 * from the project axis — it is not a project — but its totals are returned in
 * `excluded` so the UI can state exactly what it left out. Dropping spend
 * without saying so would be a lie about money.
 *
 * Kept pure (no store/window imports) so it is unit-testable directly.
 */
import type { HistoryDashboardDay, HistoryDashboardProjectRow } from '../../preload/api'
import { TASK_ROW_PREFIX, launcherOfEncodedDir, type HistoryLauncher } from './historyLauncher'

/** One launcher's share of a folded project row. */
export interface LauncherBucket {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  sessionCount: number
}

/**
 * A project row after the fold. `byLauncher` holds one bucket per launcher that
 * contributed a folder; the buckets sum to the row's own totals.
 */
export interface FoldedProjectRow extends HistoryDashboardProjectRow {
  byLauncher: Partial<Record<HistoryLauncher, LauncherBucket>>
}

export interface FoldedDay extends HistoryDashboardDay {
  byProject: Record<string, FoldedProjectRow>
}

export interface ExcludedProjects {
  /** How many encoded transcript folders had no resolvable working directory. */
  folderCount: number
  sessionCount: number
  promptCount: number
  estimatedCostUsd: number
  totalTokens: number
}

export interface FoldedHistory {
  days: FoldedDay[]
  excluded: ExcludedProjects
}

const EMPTY_EXCLUDED: ExcludedProjects = {
  folderCount: 0,
  sessionCount: 0,
  promptCount: 0,
  estimatedCostUsd: 0,
  totalTokens: 0,
}

function addToLauncher(into: FoldedProjectRow, launcher: HistoryLauncher, from: HistoryDashboardProjectRow): void {
  const dst = into.byLauncher[launcher] ?? (into.byLauncher[launcher] = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, sessionCount: 0,
  })
  dst.inputTokens += from.inputTokens
  dst.outputTokens += from.outputTokens
  dst.cacheReadTokens += from.cacheReadTokens
  dst.cacheCreationTokens += from.cacheCreationTokens
  dst.costUsd += from.estimatedCostUsd
  dst.sessionCount += from.sessionCount
}

function mergeRow(into: FoldedProjectRow, from: HistoryDashboardProjectRow, launcher: HistoryLauncher): void {
  into.promptCount += from.promptCount
  into.inputTokens += from.inputTokens
  into.outputTokens += from.outputTokens
  into.cacheReadTokens += from.cacheReadTokens
  into.cacheCreationTokens += from.cacheCreationTokens
  into.toolCallCount += from.toolCallCount
  into.sessionCount += from.sessionCount
  into.errorCount += from.errorCount
  into.activeMinutes += from.activeMinutes
  into.estimatedCostUsd += from.estimatedCostUsd
  for (const [tool, cnt] of Object.entries(from.toolBreakdown ?? {})) {
    into.toolBreakdown[tool] = (into.toolBreakdown[tool] ?? 0) + cnt
  }
  // byModel feeds facetSlice's model mix — merging the row without it would
  // silently drop one folder's model attribution while keeping its totals.
  for (const [modelId, mb] of Object.entries(from.byModel ?? {})) {
    const dst = into.byModel[modelId] ?? (into.byModel[modelId] = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    })
    dst.inputTokens += mb.inputTokens
    dst.outputTokens += mb.outputTokens
    dst.cacheReadTokens += mb.cacheReadTokens
    dst.cacheCreationTokens += mb.cacheCreationTokens
    dst.costUsd += mb.costUsd
    if (mb.estimated) dst.estimated = true
  }
  addToLauncher(into, launcher, from)
}

function cloneRow(row: HistoryDashboardProjectRow, projectDir: string, launcher: HistoryLauncher): FoldedProjectRow {
  const byModel: HistoryDashboardProjectRow['byModel'] = {}
  for (const [modelId, mb] of Object.entries(row.byModel ?? {})) byModel[modelId] = { ...mb }
  const out: FoldedProjectRow = { ...row, projectDir, toolBreakdown: { ...(row.toolBreakdown ?? {}) }, byModel, byLauncher: {} }
  addToLauncher(out, launcher, row)
  return out
}

/**
 * Re-key each day's `byProject` from encoded transcript folder → resolved cwd.
 *
 * `cwdByEncoded` comes from `useKnownProjects().projects` (encodedIds → cwd).
 * Pass an EMPTY map only when resolution genuinely produced nothing; callers
 * that are still resolving should skip the fold entirely rather than fold
 * against a half-built map, or every project momentarily reads as excluded.
 */
export function foldHistoryDaysByCwd(
  days: HistoryDashboardDay[],
  cwdByEncoded: Record<string, string>,
): FoldedHistory {
  const excluded: ExcludedProjects = { ...EMPTY_EXCLUDED }
  const excludedFolders = new Set<string>()

  const foldedDays = days.map((day) => {
    const byProject: Record<string, FoldedProjectRow> = {}
    for (const [encoded, row] of Object.entries(day.byProject)) {
      // A Task row already names its cwd — no transcript-folder lookup, and it
      // is never "unresolvable", so it never lands in `excluded`.
      if (encoded.startsWith(TASK_ROW_PREFIX)) {
        const taskCwd = encoded.slice(TASK_ROW_PREFIX.length)
        const existingTask = byProject[taskCwd]
        if (existingTask) mergeRow(existingTask, row, 'task')
        else byProject[taskCwd] = cloneRow(row, taskCwd, 'task')
        continue
      }
      const cwd = cwdByEncoded[encoded]
      if (!cwd) {
        excludedFolders.add(encoded)
        excluded.sessionCount += row.sessionCount
        excluded.promptCount += row.promptCount
        excluded.estimatedCostUsd += row.estimatedCostUsd
        excluded.totalTokens += row.inputTokens + row.outputTokens
        continue
      }
      const launcher = launcherOfEncodedDir(encoded)
      const existing = byProject[cwd]
      if (existing) mergeRow(existing, row, launcher)
      else byProject[cwd] = cloneRow(row, cwd, launcher)
    }
    return { ...day, byProject }
  })

  excluded.folderCount = excludedFolders.size
  return { days: foldedDays, excluded }
}

/** True when there is anything worth telling the user about the exclusion. */
export function hasExclusions(e: ExcludedProjects): boolean {
  return e.folderCount > 0
}

export function describeExclusions(e: ExcludedProjects): string {
  const bits = [`${e.folderCount} transcript folder${e.folderCount === 1 ? '' : 's'} with no resolvable working directory`]
  if (e.sessionCount) bits.push(`${e.sessionCount.toLocaleString()} sessions`)
  if (e.promptCount) bits.push(`${e.promptCount.toLocaleString()} prompts`)
  if (e.estimatedCostUsd >= 0.005) bits.push(`$${e.estimatedCostUsd.toFixed(2)}`)
  return `Excluded: ${bits.join(' · ')}`
}
