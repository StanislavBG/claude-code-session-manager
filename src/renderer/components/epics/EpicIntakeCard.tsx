import { useState } from 'react'
import type { EpicIntakeSection } from '../../lib/epicIntake'
import { TurnFrame } from '../ChatTranscriptTurn'

/**
 * AIM briefing card — the Epic's first turn, rendered from the structured
 * `sections` composeEpicIntake now emits (epicIntake.ts) instead of the flat
 * `openingPrompt` string. A body renderer inside the existing three-zone
 * TurnFrame (chat-turn-three-zone-frame), never a new frame: the header shows
 * a badge + timestamp (TurnFrame's own header zone), the body is one
 * collapsible card per section KIND, and the footer's Copy button copies the
 * exact wire-identical `openingPrompt` (TurnFrame's own footer zone).
 *
 * CORE: renders from `sections` data only — never regex-parses the flat
 * `openingPrompt` string back apart. Only used when `sections` is present and
 * non-empty; EpicDetail.tsx falls back to the ordinary flat-text Turn bubble
 * otherwise (an Epic minted before this field existed).
 */

const GROUP_LABEL: Record<EpicIntakeSection['kind'], string> = {
  actor: 'Actor',
  injection: 'Injections',
  input: 'Input',
  mission: 'Mission',
  goal: 'Goal',
  reference: 'References',
}

// actor/mission are the load-bearing "who + what this Epic is for" lines —
// open by default. injection/input are ambient framing the human rarely
// needs to re-read — collapsed to a one-line summary with a count. goal is
// the human's own ask, so it opens too; reference is metadata like
// injection/input.
const DEFAULT_EXPANDED: Record<EpicIntakeSection['kind'], boolean> = {
  actor: true,
  injection: false,
  input: false,
  mission: true,
  goal: true,
  reference: false,
}

interface SectionGroup {
  kind: EpicIntakeSection['kind']
  items: EpicIntakeSection[]
}

/** Sections of the same kind are always emitted contiguously by
 *  composeEpicIntake (e.g. every 'injection' entry together, every
 *  'reference' entry together) — grouping adjacent-same-kind runs turns the
 *  flat six-kind-ordered list into exactly one card per kind present. */
function groupSections(sections: EpicIntakeSection[]): SectionGroup[] {
  const groups: SectionGroup[] = []
  for (const s of sections) {
    const last = groups[groups.length - 1]
    if (last && last.kind === s.kind) last.items.push(s)
    else groups.push({ kind: s.kind, items: [s] })
  }
  return groups
}

const SUMMARY_MAX = 96

function oneLineSummary(items: EpicIntakeSection[]): string {
  if (items.length === 1) {
    const t = items[0].text.replace(/\s+/g, ' ').trim()
    return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX)}…` : t
  }
  return `${items.length} items`
}

function SectionCard({ group }: { group: SectionGroup }) {
  const [open, setOpen] = useState(DEFAULT_EXPANDED[group.kind])
  const count = group.items.length
  return (
    <div
      className="overflow-hidden rounded-lg border border-line"
      data-testid="epic-intake-section"
      data-section-kind={group.kind}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="epic-intake-section-toggle"
        className="flex w-full items-center gap-1.5 bg-elev px-2.5 py-1.5 font-mono text-[11px] font-semibold text-fg-dim hover:bg-hi"
      >
        <span className={`inline-block shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span className="shrink-0 text-left">{GROUP_LABEL[group.kind]}</span>
        {count > 1 && <span className="shrink-0 text-fg-faint">· {count}</span>}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-left font-normal text-fg-faint" data-testid="epic-intake-section-summary">
            {oneLineSummary(group.items)}
          </span>
        )}
      </button>
      {open && (
        <div className="grid gap-2 bg-bg px-2.5 py-2" data-testid="epic-intake-section-body">
          {group.items.map((item, i) => (
            <div key={i} className="min-w-0 text-sm leading-relaxed whitespace-pre-wrap text-fg">
              {group.items.length > 1 && (
                <div className="mb-0.5 font-mono text-[10px] text-fg-faint">
                  {item.label}
                  {item.source ? ` · ${item.source}` : ''}
                </div>
              )}
              {item.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function EpicIntakeCard({
  sections,
  at,
  openingPrompt,
}: {
  sections: EpicIntakeSection[]
  at: number
  openingPrompt: string
}) {
  const groups = groupSections(sections)
  return (
    <TurnFrame
      badge={
        <span
          data-testid="epic-intake-badge"
          className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
        >
          AIM briefing
        </span>
      }
      timestamp={at}
      copyText={openingPrompt}
      testId="epic-intake-card"
    >
      <div className="grid gap-1.5" data-testid="epic-intake-card-sections">
        {groups.map((g) => (
          <SectionCard key={g.kind} group={g} />
        ))}
      </div>
    </TurnFrame>
  )
}
