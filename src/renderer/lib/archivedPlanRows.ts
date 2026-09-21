/**
 * archivedPlanRows — merges archived PRD files back into the Scheduler's plan-band row set.
 *
 * A finished job's PRD .md moves to `prds-archived/` and reconcile() then drops its queue row,
 * so live `snap.jobs` alone shrinks a finished 6-step plan to its 1 live step. This adds
 * synthetic completed/failed rows for the archived steps of Epics that are ALREADY visible
 * live (never resurrecting a fully-dead Epic). Status rule mirrors epicDerive's `epicPrds`.
 *
 * Complexity: O(L + P) — one pass over live jobs for the Epic-id set, one over the PRD list.
 */
import type { PrdListItem, ScheduleJob } from '../../preload/api'
import { epicIdCandidates } from './epicProvenance'

export function mergeArchivedPlanRows(
  liveJobs: ScheduleJob[],
  prds: PrdListItem[],
  scopeCwd: string | null = null,
): ScheduleJob[] {
  if (prds.length === 0 || liveJobs.length === 0) return liveJobs
  const liveSlugs = new Set<string>()
  const liveEpics = new Set<string>()
  for (const j of liveJobs) {
    liveSlugs.add(j.slug)
    for (const id of epicIdCandidates(j)) liveEpics.add(id)
  }
  const synthetic: ScheduleJob[] = []
  for (const p of prds) {
    if (p.archived !== true || liveSlugs.has(p.slug)) continue
    if (scopeCwd && p.cwd !== scopeCwd) continue
    if (!epicIdCandidates(p).some((id) => liveEpics.has(id))) continue
    liveSlugs.add(p.slug) // dedupe archived copies of one slug too
    synthetic.push({
      slug: p.slug,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      bodyPreview: '',
      status: p.archivedStatus ?? 'completed',
      runId: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      dependsOn: p.dependsOn ?? undefined,
      sourcePromptId: p.sourcePromptId ?? null,
      epicId: p.epicId ?? null,
      synthetic: true,
    })
  }
  return synthetic.length === 0 ? liveJobs : [...liveJobs, ...synthetic]
}
