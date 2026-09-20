import { useCallback, useState } from 'react'
import type { ScheduleJob } from '../../../../preload/api.d'
import { toast } from '../../../state/toast'
import { flattenBacklogNodes, type BacklogEpicSection, type BacklogNode } from '../../../lib/backlogTree'

/** Truncates a label to keep a row single-line. */
export function truncateLabel(text: string, max = 60): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

/** Attach-target metadata for one head (root chain) of an Epic section —
 *  what the "change disposition" control offers as "attach behind <label>". */
export interface HeadChoice {
  rootSlug: string
  label: string
  /** This head's own current terminal (leaf) slug(s) — what a new dependsOn
   *  edge onto this head must point at to run behind everything already
   *  queued in it. Empty only if the head's own subtree is entirely a
   *  dependsOn cycle (backlogTree.ts renders those separately). */
  terminals: string[]
}

/** A head's terminal (leaf) slugs: nodes in its own subtree with no
 *  children — nothing else in this Epic depends on them yet. Mirrors
 *  prdDisposition.cjs's resolveChainTerminals, kept as a separate
 *  implementation since it walks the renderer's already-built BacklogNode
 *  tree rather than a flat row list (main is CJS, this is renderer TS/ESM —
 *  see CLAUDE.md's "no ES modules in main" law). */
function headTerminalSlugs(head: BacklogNode<ScheduleJob>): string[] {
  return flattenBacklogNodes([head])
    .filter((n) => n.children.length === 0)
    .map((n) => n.row.slug)
}

/** Head choices for one Epic section (one entry per head). */
export function sectionHeadChoices(section: BacklogEpicSection<ScheduleJob>): HeadChoice[] {
  return section.nodes.map((headNode) => ({
    rootSlug: headNode.row.slug,
    label: headNode.row.title || headNode.row.slug,
    terminals: headTerminalSlugs(headNode),
  }))
}

/**
 * slug → the OTHER heads of that slug's Epic section (its own head excluded),
 * i.e. the "attach behind" targets. One filtered array per head, shared by every
 * row in the head, so the Graph view's rows get a reference-stable prop.
 * O(V + H²) over one section's rows/heads.
 */
export function buildHeadChoicesBySlug(sections: BacklogEpicSection<ScheduleJob>[]): Map<string, HeadChoice[]> {
  const out = new Map<string, HeadChoice[]>()
  for (const section of sections) {
    const all = sectionHeadChoices(section)
    section.nodes.forEach((headNode, i) => {
      const others = all.filter((_, j) => j !== i)
      for (const n of flattenBacklogNodes([headNode])) out.set(n.row.slug, others)
    })
  }
  return out
}

/**
 * DispositionControl — the Scheduler UI's "change disposition" action
 * (scheduler wave-disposition PRD): promote an appended wave to its own
 * head, or re-attach a head behind another chain in the same Epic section.
 * Only rendered when `job.disposition` is set (this row was itself a
 * wave-authoring decision point) and the row is still pending/quarantined —
 * matches remote.setPrdDisposition's own running/completed refusal, so the
 * control never offers an action the backend would just reject.
 *
 * A plain `<select>` rather than two separate buttons: the "attach behind"
 * choice set is dynamic (one option per sibling head), and a menu keeps a
 * two-head Epic and a five-head Epic the same shape. Resets to the
 * placeholder after firing — this is an action trigger, not a persistent
 * setting.
 */
export function DispositionControl({ job, headChoices }: { job: ScheduleJob; headChoices: HeadChoice[] }) {
  const [pending, setPending] = useState(false)
  const fire = useCallback((disposition: 'append' | 'new-head', dependsOn?: string[]) => {
    setPending(true)
    window.api.schedule.setPrdDisposition({ slug: job.slug, cwd: job.cwd ?? undefined, disposition, dependsOn })
      .then(toast.fromOutcome)
      .catch(() => toast.error('Failed to change disposition'))
      .finally(() => setPending(false))
  }, [job.slug, job.cwd])

  if (job.disposition !== 'append' && headChoices.length === 0) return null

  return (
    <select
      data-testid="job-row-disposition-control"
      disabled={pending}
      value=""
      onChange={(e) => {
        const v = e.target.value
        if (v === '__new-head__') fire('new-head')
        else if (v) {
          const target = headChoices.find((h) => h.rootSlug === v)
          if (target) fire('append', target.terminals)
        }
      }}
      className="text-[13px] font-semibold text-fg-dim hover:text-fg bg-transparent border border-line/60 rounded px-1.5 py-0.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      title="Change this wave's relationship to the rest of the Epic's plan"
    >
      <option value="" disabled>change disposition…</option>
      {job.disposition === 'append' && (
        <option value="__new-head__">promote to new head</option>
      )}
      {headChoices.map((h) => (
        <option key={h.rootSlug} value={h.rootSlug}>attach behind: {truncateLabel(h.label, 40)}</option>
      ))}
    </select>
  )
}
