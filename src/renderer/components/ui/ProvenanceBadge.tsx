/**
 * ProvenanceBadge — origin marker for Skills / MCP / Plugins / Subagents /
 * Hooks. Renders the resolved origin (manual override, else auto-classified)
 * as a colored pill: Anthropic (accent) / Community (warn) / Local (dim).
 *
 * When interactive (default), clicking opens a small menu to override the
 * auto-detection per item; the choice persists to the provenance sidecar. A
 * manual override is marked with a dot and explained in the tooltip.
 */
import { useEffect, useRef, useState } from 'react'
import { useHomeDir } from '../../lib/useHomeDir'
import { useProvenance } from '../../state/provenance'
import {
  classifyProvenance,
  provenanceKey,
  PROVENANCE_LABEL,
  type Provenance,
  type ProvenanceInput,
} from '../../lib/provenance'

const TONE: Record<Provenance, string> = {
  anthropic: 'bg-accent/15 text-accent border-accent/30',
  community: 'bg-yellow-950/30 text-yellow-500/80 border-yellow-900/40',
  local: 'bg-bg-elev text-fg-faint border-line',
}

const ORDER: Provenance[] = ['anthropic', 'community', 'local']

export function ProvenanceBadge({
  input,
  scope,
  interactive = true,
  className = '',
}: {
  input: ProvenanceInput
  /** Scope discriminator for the override key (user/project/local). */
  scope?: string | null
  interactive?: boolean
  className?: string
}) {
  const home = useHomeDir()
  const { overrides, load, setOverride } = useProvenance()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (home) void load(home)
  }, [home, load])

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const key = provenanceKey(input.type, scope ?? null, input.name)
  const auto = classifyProvenance(input)
  const override = overrides[key]
  const provenance = override ?? auto.provenance

  const title = override
    ? `Origin manually set to ${PROVENANCE_LABEL[provenance]} — auto-detected ${PROVENANCE_LABEL[auto.provenance]} (${auto.reason})`
    : `Auto-detected ${PROVENANCE_LABEL[provenance]}: ${auto.reason}`

  const pill = (
    <span
      className={`inline-flex items-center gap-1 text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide ${TONE[provenance]} ${interactive ? 'cursor-pointer hover:brightness-125' : ''} ${className}`}
      title={title}
    >
      {PROVENANCE_LABEL[provenance]}
      {override && <span className="w-1 h-1 rounded-full bg-current opacity-70" aria-hidden />}
    </span>
  )

  if (!interactive) return pill

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="inline-flex"
        aria-label={`Origin: ${PROVENANCE_LABEL[provenance]}. Click to change.`}
      >
        {pill}
      </button>
      {open && (
        <span
          className="absolute z-50 top-full right-0 mt-1 min-w-[7.5rem] rounded-md border border-line bg-bg-elev shadow-lg py-1 text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="block px-2 pb-1 text-[10px] uppercase tracking-wide text-fg-faint">Mark origin as</span>
          {ORDER.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => { void setOverride(key, p); setOpen(false) }}
              className={`flex w-full items-center gap-2 px-2 py-1 text-[12px] hover:bg-bg-hi/60 ${provenance === p ? 'text-fg' : 'text-fg-dim'}`}
            >
              <span className={`w-2 h-2 rounded-full border ${TONE[p]}`} aria-hidden />
              {PROVENANCE_LABEL[p]}
              {override === p && <span className="ml-auto text-[10px] text-fg-faint">set</span>}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            onClick={() => { void setOverride(key, null); setOpen(false) }}
            disabled={!override}
            className="flex w-full items-center gap-2 px-2 py-1 text-[12px] text-fg-dim hover:bg-bg-hi/60 disabled:opacity-40 disabled:hover:bg-transparent"
            title={`Revert to auto-detection (${PROVENANCE_LABEL[auto.provenance]})`}
          >
            Auto-detect
            <span className="ml-auto text-[10px] text-fg-faint">{PROVENANCE_LABEL[auto.provenance]}</span>
          </button>
        </span>
      )}
    </span>
  )
}
