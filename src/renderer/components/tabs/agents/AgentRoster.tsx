import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentPersona, Armory } from '../../../../preload/api'
import { COLOR_SWATCH } from './AgentDetail'

/**
 * AgentRoster — Agents tab landing (DESIGN_SPEC.md frame 1a): a grid of character cards, loadout state
 * first, state filter chips, a "no loadout decision" banner and the sort "Needs a decision first".
 * Presentational: the parent owns the persona list and opens a sheet via `onOpen`.
 */

export type LoadoutState = 'undecided' | 'equipped' | 'bare' | 'unbound'
const STATES: readonly LoadoutState[] = ['undecided', 'equipped', 'bare', 'unbound']
type Chip = 'all' | LoadoutState
const COLUMNS = 4

// Honey is reserved for Undecided (DESIGN_SPEC deviation 5); Unbound is the rust hatch.
const HONEY = '#d3a23c'
const HONEY_FG = '#7b560e'
const RUST = '#a3441f'

/** The persona's loadout state. `loadout` is written by the gear backend; a persona without one has had no decision. */
export function loadoutOf(p: AgentPersona): LoadoutState {
  const v = (p as AgentPersona & { loadout?: string }).loadout
  return (STATES as readonly string[]).includes(v ?? '') ? (v as LoadoutState) : 'undecided'
}

/** Needs-a-decision first (Undecided), then everyone else by name. */
export function sortRoster(list: readonly AgentPersona[]): AgentPersona[] {
  const rank = (p: AgentPersona) => (loadoutOf(p) === 'undecided' ? 0 : 1)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function stateCounts(list: readonly AgentPersona[]): Record<Chip, number> {
  const c: Record<Chip, number> = { all: list.length, undecided: 0, equipped: 0, bare: 0, unbound: 0 }
  for (const p of list) c[loadoutOf(p)]++
  return c
}

function serversOf(p: AgentPersona): string[] {
  const s = new Set<string>()
  for (const t of p.tools) {
    const m = /^mcp__(.+?)__/.exec(t)
    if (m) s.add(m[1])
  }
  return [...s]
}

function builtinsOf(p: AgentPersona): string[] {
  return p.tools.filter((t) => t !== '*' && !t.startsWith('mcp__'))
}

export const LOADOUT_DOT: Record<LoadoutState, string> = { undecided: '#d3a23c', equipped: '#6f7d52', bare: '#9a9a9a', unbound: '#a3441f' }

/** One-line loadout summary of a persona (list rows). */
export function loadoutSummary(p: AgentPersona): string { return summaryOf(p, loadoutOf(p)) }

function summaryOf(p: AgentPersona, state: LoadoutState): string {
  if (state === 'undecided') return 'Undecided — choose a loadout'
  if (state === 'unbound') return 'Unbound — every tool'
  if (state === 'bare') return 'Bare — floor only'
  const parts = [`${builtinsOf(p).length} tools`]
  const n = serversOf(p).length
  if (n) parts.push(`${n} server${n > 1 ? 's' : ''}`)
  const packs = (p as AgentPersona & { packs?: string[] }).packs?.length ?? 0
  if (packs) parts.push(`${packs} pack${packs > 1 ? 's' : ''}`)
  return parts.join(' · ')
}

function avatarColor(c: string | null): string {
  if (!c) return '#8a7a60'
  return COLOR_SWATCH[c] ?? (c.startsWith('#') ? c : '#8a7a60')
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function Pips({ value }: { value: string | null }) {
  const at = value ? EFFORTS.indexOf(value as (typeof EFFORTS)[number]) : -1
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {EFFORTS.map((l, i) => (
        <span key={l} className={`w-1.5 h-1.5 rounded-full ${i <= at ? 'bg-fg-dim' : 'bg-line'}`} />
      ))}
    </span>
  )
}

const CHIPS: { key: Chip; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'undecided', label: 'Undecided' },
  { key: 'equipped', label: 'Equipped' },
  { key: 'bare', label: 'Bare' },
  { key: 'unbound', label: 'Unbound' },
]

export interface AgentRosterProps {
  personas: readonly AgentPersona[]
  filter: string
  onFilterChange: (v: string) => void
  onOpen: (name: string) => void
  onNew: () => void
  /** Personas | Tags switch. */
  view: 'personas' | 'tags'
  onView: (v: 'personas' | 'tags') => void
}

export function AgentRoster({ personas, filter, onFilterChange, onOpen, onNew, view, onView }: AgentRosterProps) {
  const [chip, setChip] = useState<Chip>('all')
  const [armory, setArmory] = useState<Armory | null>(null)
  useEffect(() => {
    let live = true
    try {
      const p = window.api.agents.armory?.({})
      p?.then((a) => { if (live) setArmory(a) }).catch(() => {})
    } catch { /* roster still renders without server status */ }
    return () => { live = false }
  }, [])
  const failing = useMemo(
    () => new Set((armory?.mcpServers ?? []).filter((s) => s.status === 'failing').map((s) => s.label)),
    [armory],
  )

  const counts = useMemo(() => stateCounts(personas), [personas])
  const needle = filter.toLowerCase()
  const shown = useMemo(
    () => sortRoster(personas).filter((p) =>
      (chip === 'all' || loadoutOf(p) === chip) &&
      (!needle || p.name.toLowerCase().includes(needle) || (p.description ?? '').toLowerCase().includes(needle))),
    [personas, chip, needle],
  )

  const cards = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? COLUMNS : e.key === 'ArrowUp' ? -COLUMNS : 0
    if (move) {
      e.preventDefault()
      cards.current[Math.min(shown.length - 1, Math.max(0, i + move))]?.focus()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onOpen(shown[i].name)
    }
  }

  const undecided = counts.undecided

  return (
    <div data-testid="agent-roster" className="flex flex-col gap-4 p-6 h-full min-h-0 overflow-auto">
      <div className="flex items-end gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] font-semibold tracking-[0.1em] text-fg-faint uppercase">Claude config · ~/.claude/agents/</div>
          <h2 className="text-2xl font-semibold text-fg">
            Agents <span className="font-serif italic font-normal text-fg-dim">the roster</span>
          </h2>
        </div>
        <div role="group" aria-label="Agents view" data-testid="agent-view-switch" className="inline-flex items-center p-0.5 rounded bg-bg-hi border border-line">
          {(['personas', 'tags'] as const).map((k) => (
            <button
              type="button" key={k} onClick={() => onView(k)} aria-pressed={view === k}
              className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${view === k ? 'bg-bg text-fg font-medium shadow-sm' : 'text-fg-dim hover:text-fg'}`}
            >
              {k === 'personas' ? 'Personas' : 'Tags'}
            </button>
          ))}
        </div>
        <input
          value={filter} onChange={(e) => onFilterChange(e.target.value)} placeholder="Filter" aria-label="Filter agents"
          className="h-9 w-56 px-3 rounded-lg bg-bg-hi border border-line text-sm text-fg placeholder:text-fg-faint"
        />
        <button type="button" onClick={onNew} className="h-9 px-4 rounded-lg bg-accent text-white text-sm font-semibold">+ New</button>
      </div>

      <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Loadout state">
        {CHIPS.map((c) => (
          <button
            type="button" key={c.key} data-testid={`roster-chip-${c.key}`} aria-pressed={chip === c.key}
            onClick={() => setChip(c.key)}
            className={`px-3 py-1 rounded-full text-xs border transition-colors ${chip === c.key ? 'bg-fg text-bg border-fg font-semibold' : 'bg-bg-hi text-fg-dim border-line hover:text-fg'}`}
          >
            {c.label} <span className="opacity-70">{counts[c.key]}</span>
          </button>
        ))}
        <span className="flex-1" />
        <span className="text-xs text-fg-faint">Sort: Needs a decision first</span>
      </div>

      {undecided > 0 && (
        <div
          data-testid="roster-banner" role="status"
          className="flex items-center gap-3 px-4 py-2.5 rounded-xl border text-sm"
          style={{ background: 'rgba(211,162,60,.12)', borderColor: 'rgba(211,162,60,.45)', color: HONEY_FG }}
        >
          <span className="w-2 h-2 rounded-full" style={{ background: HONEY }} />
          <span className="flex-1 font-medium">{undecided} agent{undecided > 1 ? 's have' : ' has'} no loadout decision</span>
          <button type="button" data-testid="roster-review" onClick={() => setChip('undecided')} className="font-semibold underline-offset-2 hover:underline">
            Review the {undecided} →
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="text-sm text-fg-faint italic">no agents match</div>
      ) : (
        <div role="listbox" aria-label="Agents" className="grid gap-3" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
          {shown.map((p, i) => {
            const state = loadoutOf(p)
            const servers = serversOf(p)
            const bad = servers.filter((s) => failing.has(s))
            const overrides = p.overridingProjects.length
            const note = bad.length ? `${bad[0]} server failing` : overrides ? `${overrides} project override${overrides > 1 ? 's' : ''}` : null
            const gear = builtinsOf(p)
            return (
              <button
                type="button" role="option" aria-selected={false} key={p.name}
                data-agent-row={p.name} data-testid="agent-card" data-loadout={state}
                ref={(el) => { cards.current[i] = el }}
                onClick={() => onOpen(p.name)}
                onKeyDown={(e) => onKey(e, i)}
                className="relative text-left flex flex-col gap-2 p-3.5 pt-4 rounded-2xl bg-bg-hi border border-line overflow-hidden hover:border-fg-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {state === 'unbound' && (
                  <span
                    data-testid="agent-card-hatch" aria-hidden="true"
                    className="absolute inset-x-0 top-0 h-1"
                    style={{ backgroundImage: `repeating-linear-gradient(135deg, ${RUST} 0 4px, transparent 4px 8px)` }}
                  />
                )}
                <div className="flex items-center gap-2.5">
                  <span
                    className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center font-serif text-lg font-semibold text-white"
                    style={{ background: avatarColor(p.color) }}
                  >
                    {p.name[0]?.toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-mono text-[13px] font-semibold text-fg truncate">{p.name}</span>
                    <span className="block font-serif italic text-xs text-fg-dim truncate">{p.description || 'no description'}</span>
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10.5px] text-fg-faint">
                  <span className="flex items-center gap-1.5">MODEL <span data-testid="agent-row-model" className="font-mono text-fg-dim">{p.model ?? 'inherit'}</span></span>
                  <span className="flex items-center gap-1.5">EFFORT <Pips value={p.effort} /></span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className="px-2 py-0.5 rounded-full text-[10.5px] font-semibold border capitalize"
                    style={
                      state === 'undecided' ? { background: 'rgba(211,162,60,.18)', borderColor: HONEY, color: HONEY_FG }
                      : state === 'unbound' ? { borderColor: RUST, color: RUST }
                      : undefined
                    }
                  >
                    {state}
                  </span>
                  <span className="text-fg-dim truncate" style={state === 'undecided' ? { color: HONEY_FG } : undefined}>{summaryOf(p, state)}</span>
                </div>
                <div className="flex flex-wrap gap-1 min-h-[20px]">
                  {gear.slice(0, 4).map((g) => (
                    <span key={g} className="px-1.5 py-0.5 rounded bg-bg border border-line text-[10.5px] font-mono text-fg-dim">{g}</span>
                  ))}
                  {gear.length > 4 && <span className="text-[10.5px] text-fg-faint self-center">+{gear.length - 4}</span>}
                  {servers.slice(0, 2).map((s) => (
                    <span key={s} className="px-1.5 py-0.5 rounded bg-bg border border-line text-[10.5px] font-mono text-fg-dim">{s}</span>
                  ))}
                </div>
                {note && (
                  <div className="mt-auto pt-2 border-t border-line text-[11px] text-fg-faint" style={bad.length ? { color: RUST } : undefined}>{note}</div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
