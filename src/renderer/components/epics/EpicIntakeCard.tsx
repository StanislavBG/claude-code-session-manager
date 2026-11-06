import { useEffect, useRef, useState } from 'react'
import {
  AIM_SLOT_ORDER,
  toAimSections,
  type AimPart,
  type AimSection,
  type AimSlot,
  type EpicIntakeSection,
} from '../../lib/epicIntake'
import { estimateTokens } from '../../lib/estimateTokens'

/**
 * Launch briefing card — the Epic's first turn, rendered from the structured
 * `sections` composeEpicIntake emits (epicIntake.ts) instead of the flat
 * `openingPrompt` string. Collapsed to a header + chip row by default so the
 * conversation starts higher on screen; Show (or a chip) reveals the section
 * bodies below.
 *
 * CORE: renders from `sections` data only — never regex-parses the flat
 * `openingPrompt` string back apart. Only used when `sections` is present and
 * non-empty; EpicDetail.tsx falls back to the ordinary flat-text Turn bubble
 * otherwise (an Epic minted before this field existed).
 */

const GROUP_LABEL: Record<AimSlot, string> = {
  actor: 'Actor',
  input: 'Input',
  mission: 'Mission',
}

// Actor + Mission are the load-bearing "who + what this Epic is for" lines —
// open by default once the card is expanded. Input is ambient framing.
const DEFAULT_EXPANDED: Record<AimSlot, boolean> = {
  actor: true,
  input: false,
  mission: true,
}

const PART_LABEL: Record<Exclude<AimPart, 'injection'>, string> = {
  persona: 'Persona',
  grounding: 'Grounding',
  reference: 'Reference',
  'job-type': 'Job type',
  goal: 'Goal',
}

function entryLabel(item: AimSection): string {
  const base = item.part === 'injection' ? item.label : PART_LABEL[item.part]
  return item.source ? `${base} · ${item.source}` : base
}

interface SectionGroup {
  kind: AimSlot
  items: AimSection[]
}

/** One group per AIM slot present, in Actor, Input, Mission order. */
function groupSections(sections: readonly EpicIntakeSection[]): SectionGroup[] {
  const aim = toAimSections(sections)
  const groups: SectionGroup[] = []
  for (const kind of AIM_SLOT_ORDER) {
    const items = aim.filter((s) => s.kind === kind)
    if (items.length > 0) groups.push({ kind, items })
  }
  return groups
}

const SUMMARY_MAX = 96

/**
 * A section longer than this starts COLLAPSED regardless of its kind's
 * DEFAULT_EXPANDED entry. `goal` is the human's own ask and normally wants to
 * be open, but a multi-thousand-word opening prompt rendered in full pushes
 * every reply off-screen and makes the Session details view unusable — so past
 * this budget it degrades to the same thin one-line summary the ambient
 * sections use, and the human expands it when they actually want to re-read it.
 */
const LONG_SECTION_CHARS = 400

function groupChars(items: AimSection[]): number {
  return items.reduce((n, s) => n + s.text.length, 0)
}

function oneLineSummary(items: AimSection[]): string {
  if (items.length === 1) {
    const t = items[0].text.replace(/\s+/g, ' ').trim()
    return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX)}…` : t
  }
  return `${items.length} items`
}

function SectionCard({
  group,
  open,
  onToggle,
  innerRef,
}: {
  group: SectionGroup
  open: boolean
  onToggle: () => void
  innerRef: (el: HTMLDivElement | null) => void
}) {
  const long = groupChars(group.items) > LONG_SECTION_CHARS
  const count = group.items.length
  return (
    <div
      ref={innerRef}
      tabIndex={-1}
      className="overflow-hidden rounded-lg border border-line"
      data-testid="epic-intake-section"
      data-section-kind={group.kind}
    >
      <button
        type="button"
        onClick={onToggle}
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
        // Even expanded, a long section scrolls inside its own box rather than
        // growing the page without bound.
        <div
          className={`grid gap-2 bg-bg px-2.5 py-2 ${long ? 'max-h-[45vh] overflow-y-auto' : ''}`}
          data-testid="epic-intake-section-body"
        >
          {group.items.map((item, i) => (
            <div key={i} className="min-w-0 text-sm leading-relaxed whitespace-pre-wrap text-fg">
              {group.items.length > 1 && (
                <div className="mb-0.5 font-mono text-[10px] text-fg-faint">
                  {entryLabel(item)}
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
  at: _at,
  openingPrompt,
}: {
  sections: readonly EpicIntakeSection[]
  at: number
  openingPrompt: string
}) {
  const groups = groupSections(sections)
  const tokens = estimateTokens(openingPrompt)
  const [expanded, setExpanded] = useState(false)
  const [openKinds, setOpenKinds] = useState<Partial<Record<AimSlot, boolean>>>({})
  const [focusKind, setFocusKind] = useState<AimSlot | null>(null)
  const sectionRefs = useRef<Partial<Record<AimSlot, HTMLDivElement>>>({})

  useEffect(() => {
    if (!focusKind) return
    const el = sectionRefs.current[focusKind]
    if (el) {
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
      el.focus()
    }
    setFocusKind(null)
  }, [focusKind, expanded])

  // A long section starts collapsed regardless of its kind's default, same
  // guard LONG_SECTION_CHARS enforced before this state moved up from
  // SectionCard — Show reveals the list, it doesn't force every body open.
  function isOpen(group: SectionGroup): boolean {
    const long = groupChars(group.items) > LONG_SECTION_CHARS
    return openKinds[group.kind] ?? (DEFAULT_EXPANDED[group.kind] && !long)
  }

  function toggleSection(group: SectionGroup) {
    setOpenKinds((prev) => ({ ...prev, [group.kind]: !isOpen(group) }))
  }

  function handleShowToggle() {
    setExpanded((prev) => !prev)
  }

  function handleChipClick(kind: AimSlot) {
    setExpanded(true)
    setOpenKinds((prev) => ({ ...prev, [kind]: true }))
    setFocusKind(kind)
  }

  return (
    <div
      data-testid="epic-intake-card"
      className="rounded-card border border-dashed border-sage/40 bg-sage/5"
    >
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div data-testid="epic-intake-badge" className="font-mono text-[10px] font-semibold uppercase tracking-wide text-sage-dark">
            Launch briefing
          </div>
          <p className="mt-0.5 text-xs text-fg-faint">Sent to the agent at start — not part of the conversation</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="whitespace-nowrap font-mono text-[11px] text-fg-faint">
            {groups.length} sections · {tokens.toLocaleString()} tok
          </span>
          <button
            type="button"
            data-testid="epic-intake-toggle"
            onClick={handleShowToggle}
            className="whitespace-nowrap font-mono text-[11px] font-semibold text-accent hover:underline"
          >
            {expanded ? 'Hide ▴' : 'Show ▾'}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
        {groups.map((g) => (
          <button
            key={g.kind}
            type="button"
            data-testid="epic-intake-chip"
            data-chip-kind={g.kind}
            onClick={() => handleChipClick(g.kind)}
            className="rounded border border-sage/40 bg-sage/10 px-1.5 py-0.5 font-mono text-[10px] text-sage-dark hover:bg-sage/20"
          >
            {GROUP_LABEL[g.kind]}
          </button>
        ))}
      </div>
      {expanded && (
        <div className="grid gap-1.5 px-3 pb-3" data-testid="epic-intake-card-sections">
          {groups.map((g) => (
            <SectionCard
              key={g.kind}
              group={g}
              open={isOpen(g)}
              onToggle={() => toggleSection(g)}
              innerRef={(el) => {
                if (el) sectionRefs.current[g.kind] = el
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
