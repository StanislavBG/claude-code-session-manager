import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Recipe } from '../../../../preload/api'
import { useHives } from '../../../state/hives'
import { referencedAgentNames } from '../../../state/hives'
import { useOrchestrator } from '../../../state/orchestrator'
import { useDispatch } from '../../../state/dispatch'
import { useActiveTab } from '../../../lib/useActiveTab'
import { useAgentNames } from '../../../lib/useAgentNames'
import { resolveRecipeRoles } from '../../../lib/resolveRecipeRoles'
import { toast } from '../../../state/toast'
import { HiveManagerModal } from '../../modals/HiveManagerModal'

// Named-tool chip used in agent editor and library cards.
export function ToolChip({
  tone,
  children,
}: {
  tone: 'readonly' | 'write'
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-medium rounded border ${
        tone === 'write'
          ? 'border-butter/60 bg-butter/20 text-fg-dim'
          : 'border-sage/60 bg-sage/10 text-sage'
      }`}
    >
      {children}
    </span>
  )
}

// Six muted Almanac-family accents cycling per hive index. Class names are
// written as full literals so Tailwind's content scanner includes them all.
const HIVE_PALETTE = [
  { text: 'text-accent',     bg: 'bg-accent',     border: 'border-accent',     ring: 'ring-accent' },
  { text: 'text-sage',       bg: 'bg-sage',       border: 'border-sage',       ring: 'ring-sage' },
  { text: 'text-butter',     bg: 'bg-butter',     border: 'border-butter',     ring: 'ring-butter' },
  { text: 'text-hive-slate', bg: 'bg-hive-slate', border: 'border-hive-slate', ring: 'ring-hive-slate' },
  { text: 'text-hive-plum',  bg: 'bg-hive-plum',  border: 'border-hive-plum',  ring: 'ring-hive-plum' },
  { text: 'text-hive-teal',  bg: 'bg-hive-teal',  border: 'border-hive-teal',  ring: 'ring-hive-teal' },
] as const

type PaletteEntry = (typeof HIVE_PALETTE)[number]

// Callers always pass i >= 0 (array index or 0-guarded literal).
export function paletteAt(i: number): PaletteEntry {
  return HIVE_PALETTE[i % HIVE_PALETTE.length]
}

// Derive a time/cost estimate from a role count.
function hiveEstimate(roleCount: number) {
  return {
    estMin: Math.round(1.5 + roleCount),
    estCost: (0.15 * roleCount).toFixed(2),
  }
}

// Hexagonal hive-cell SVG. Uses currentColor so the wrapping element's
// text-{color} class drives the fill.
export function HiveCell({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="block shrink-0" aria-hidden>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="currentColor" />
    </svg>
  )
}

// Status pill for agent rows: running (accent + pulse dot) or done (sage).
export function StatusPill({ state }: { state: 'running' | 'done' }) {
  if (state === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent text-white text-[11.5px] font-semibold font-sans">
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse shrink-0" />
        running
      </span>
    )
  }
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-semibold font-sans text-sage border border-sage/40 bg-bg">
      done
    </span>
  )
}

// Stable tab definitions hoisted to module level to avoid re-allocation per render.
const HIVE_TABS: { id: 'launch' | 'live' | 'agents'; label: string }[] = [
  { id: 'launch', label: 'Launch' },
  { id: 'live', label: 'Live' },
  { id: 'agents', label: 'Agents' },
]

// Sub-tab bar: Launch | Live | Agents.
export function HiveSubTabs({
  value,
  onChange,
}: {
  value: 'launch' | 'live' | 'agents'
  onChange: (v: 'launch' | 'live' | 'agents') => void
}) {
  const tabs = HIVE_TABS
  return (
    <div className="inline-flex gap-1 bg-elev p-1 rounded-xl ring-1 ring-line">
      {tabs.map((t) => {
        const active = value === t.id
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-[9px] text-[13.5px] transition-colors ${
              active
                ? 'bg-hi ring-1 ring-line shadow-sm text-fg font-semibold'
                : 'font-medium text-fg-dim hover:text-fg'
            }`}
          >
            {t.label}
            {t.id === 'live' && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            )}
          </button>
        )
      })}
    </div>
  )
}

// Inline scope chip showing project/context info.
function ScopeChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 bg-bg border border-line rounded-lg px-2 py-1 font-mono text-xs text-fg-dim">
      {children}
    </span>
  )
}

// Step header used in the Launch view. `n` is optional — when omitted the
// numbered badge is dropped (used now that the shared brief lives outside).
export function StepHeader({ n, title, hint }: { n?: string; title: string; hint: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2.5">
        {n && (
          <span className="w-[22px] h-[22px] rounded-[7px] bg-accent text-white grid place-items-center font-mono text-xs font-bold shrink-0">
            {n}
          </span>
        )}
        <span className="font-serif text-[22px] font-semibold text-fg leading-tight">{title}</span>
      </div>
      <p className={`mt-1.5 mb-0 text-xs text-fg-dim leading-[1.45] max-w-[560px] ${n ? 'ml-8' : ''}`}>{hint}</p>
    </div>
  )
}

// Fan-out diagram: main session → N agent cells → single digest.
function FanoutDiagram({ hive, pal }: { hive: Recipe; pal: PaletteEntry }) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-center rounded-xl border border-line bg-bg p-3">
      {/* Main session node */}
      <div className="flex flex-col items-center gap-1.5">
        <div className="w-10 h-10 rounded-lg border border-line bg-hi grid place-items-center">
          <span className={`font-mono text-xs font-bold ${pal.text}`}>M</span>
        </div>
        <span className="font-mono text-[10px] text-fg-faint text-center leading-tight">
          main<br />session
        </span>
      </div>

      {/* Fan of steps */}
      <div className="flex flex-col gap-1.5 min-w-0">
        {hive.steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-8 border-t border-rule shrink-0" />
            <div className="flex items-center gap-2 bg-hi border border-line rounded-lg px-2.5 py-1 flex-1 min-w-0">
              <span className={`shrink-0 ${pal.text}`}>
                <HiveCell size={11} />
              </span>
              <span className="font-mono text-[11.5px] text-fg font-medium truncate">{step.agentName}</span>
              <span className="ml-auto text-[10px] text-fg-faint whitespace-nowrap shrink-0">isolated ctx</span>
            </div>
          </div>
        ))}
      </div>

      {/* Digest node */}
      <div className="flex flex-col items-center gap-1.5">
        <div className={`w-10 h-10 rounded-lg border-2 ${pal.border} grid place-items-center ${pal.text}`}>
          <span className="font-mono text-sm font-bold">≡</span>
        </div>
        <span className="font-mono text-[10px] text-fg-faint text-center leading-tight">
          one<br />digest
        </span>
      </div>
    </div>
  )
}

// Selectable recipe card for a single hive.
function RecipeCard({
  hive,
  paletteIndex,
  active,
  onClick,
}: {
  hive: Recipe
  paletteIndex: number
  active: boolean
  onClick: () => void
}) {
  const pal = paletteAt(paletteIndex)
  const { estMin, estCost } = hiveEstimate(hive.steps.length)

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl p-3.5 transition-shadow border ${
        active
          ? `bg-hi ${pal.border} ring-1 ${pal.ring} shadow-md`
          : 'bg-bg border-line hover:shadow-sm'
      }`}
    >
      <div className="flex items-center gap-2.5 mb-1">
        <span className={`shrink-0 ${pal.text}`}>
          <HiveCell size={16} />
        </span>
        <span className="font-serif text-[18px] font-semibold text-fg leading-tight">{hive.name}</span>
        {active && (
          <span className={`ml-auto text-[11px] font-bold uppercase tracking-wide ${pal.text}`}>
            Selected
          </span>
        )}
      </div>
      <p className="text-[13px] text-fg-dim leading-[1.45] mb-2.5">{hive.description}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {hive.steps.map((step, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 bg-elev border border-line rounded-[7px] px-2 py-0.5"
          >
            <span className={pal.text}>
              <HiveCell size={10} />
            </span>
            <span className="font-mono text-[11px] text-fg-dim">{step.agentName}</span>
          </span>
        ))}
        <span className="ml-auto font-mono text-[11px] text-fg-faint whitespace-nowrap">
          ~{estMin} min · ~${estCost} est.
        </span>
      </div>
    </button>
  )
}

// The full Launch sub-view: recipe picker + target textarea + "What will happen" panel.
export function LaunchView({
  onSwitchToLive,
}: {
  onSwitchToLive: () => void
}) {
  const list = useHives((s) => s.list)
  const loadHives = useHives((s) => s.load)
  const launchHive = useOrchestrator((s) => s.launchHive)
  const brief = useDispatch((s) => s.brief)
  const activeTab = useActiveTab()

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [managerOpen, setManagerOpen] = useState(false)

  // Collect installed agents from both scopes to validate recipe steps.
  const { agents: userAgents } = useAgentNames('user')
  const { agents: projectAgents } = useAgentNames('project')
  const allAgents = useMemo(
    () => {
      const seen = new Set<string>()
      const merged = []
      for (const a of [...userAgents, ...projectAgents]) {
        if (!seen.has(a.name)) { seen.add(a.name); merged.push(a) }
      }
      return merged
    },
    [userAgents, projectAgents],
  )

  // Load hives if the list is empty (mirrors HiveManagerModal behaviour).
  useEffect(() => {
    if (list.length === 0) void loadHives()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-select the first hive once the list resolves.
  useEffect(() => {
    if (list.length > 0 && !selectedSlug) setSelectedSlug(list[0].slug)
  }, [list, selectedSlug])

  const selectedIndex = list.findIndex((h) => h.slug === selectedSlug)
  const selectedHive: Recipe | null = selectedIndex >= 0 ? list[selectedIndex] : null
  const pal = paletteAt(selectedIndex >= 0 ? selectedIndex : 0)

  const stepCount = selectedHive?.steps.length ?? 0
  const { estMin, estCost } = hiveEstimate(stepCount)

  // Derive the project label from the active tab's working directory.
  const cwdParts = activeTab?.cwd?.split('/').filter(Boolean) ?? []
  const projectLabel = cwdParts[cwdParts.length - 1] ?? 'no active project'

  // Compute which agent names referenced by the selected recipe are not installed.
  const missingAgents = useMemo(() => {
    if (!selectedHive) return []
    const needed = referencedAgentNames(selectedHive)
    const byName = new Set(allAgents.map((a) => a.name))
    return needed.filter((n) => !byName.has(n))
  }, [selectedHive, allAgents])

  const handleLaunch = async () => {
    if (!selectedHive) return
    if (selectedHive.steps.length === 0) {
      toast.warn('This recipe has no steps to launch.')
      return
    }
    if (missingAgents.length > 0) {
      toast.warn(`Cannot launch: missing agents — ${missingAgents.join(', ')}`)
      return
    }

    const sharedBrief = brief.trim() || selectedHive.brief || ''

    const readBody = async (path: string): Promise<string | null> => {
      const r = await window.api.config.readText(path)
      return r.exists && !r.error ? r.text : null
    }

    // Merge the shared brief into the recipe so the resolver can append it.
    const recipeWithBrief: Recipe = sharedBrief
      ? { ...selectedHive, brief: sharedBrief }
      : selectedHive

    const { roles, missing } = await resolveRecipeRoles(recipeWithBrief, allAgents, readBody)

    if (missing.length > 0) {
      toast.error(`Cannot launch: could not read agents — ${missing.join(', ')}`)
      return
    }

    launchHive({
      name: selectedHive.name,
      defaultPlan: sharedBrief || undefined,
      roles,
    })
    onSwitchToLive()
  }

  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
      <HiveManagerModal open={managerOpen} onClose={() => setManagerOpen(false)} variant="overlay" />
      {/* ── LEFT: pick a recipe ── */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <StepHeader
            title="Pick a recipe"
            hint="A preset bundle of subagents. Each works in parallel, in isolation, on the brief above."
          />
          <button
            type="button"
            onClick={() => setManagerOpen(true)}
            className="shrink-0 text-xs text-fg-dim hover:text-fg px-2.5 py-1 rounded-lg border border-line hover:bg-hi transition-colors"
          >
            Manage recipes
          </button>
        </div>
        <div className="flex flex-col gap-2.5">
          {list.length === 0 && (
            <div className="text-sm text-fg-faint italic py-4 text-center">Loading hives…</div>
          )}
          {list.map((hive, i) => (
            <RecipeCard
              key={hive.slug}
              hive={hive}
              paletteIndex={i}
              active={hive.slug === selectedSlug}
              onClick={() => setSelectedSlug(hive.slug)}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-4">
          <span className="text-xs text-fg-faint">Scope</span>
          <ScopeChip>
            <span className="text-fg-faint" aria-hidden>⬡</span>
            {projectLabel}
          </ScopeChip>
          {activeTab?.cwd && (
            <ScopeChip>
              <span className="font-mono text-[10px]">{activeTab.cwd.replace(/^\/home\/[^/]+/, '~')}</span>
            </ScopeChip>
          )}
        </div>
      </div>

      {/* ── RIGHT: What will happen (sticky) ── */}
      <div className="xl:sticky xl:top-6">
        <div className="bg-hi border border-line rounded-2xl overflow-hidden shadow-lg">
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-rule">
            <div className="text-[11px] font-bold tracking-[0.8px] uppercase text-fg-faint mb-2">
              What will happen
            </div>
            <p className="m-0 font-serif text-lg leading-[1.4] text-fg">
              <strong className={pal.text}>{stepCount} agent{stepCount !== 1 ? 's' : ''}</strong>
              {' '}run in parallel — each in its own context — and hand back a single digest.
            </p>
          </div>

          {/* Fan-out diagram */}
          {selectedHive && (
            <div className="px-4 py-3 border-b border-rule">
              <FanoutDiagram hive={selectedHive} pal={pal} />
            </div>
          )}

          {/* Per-step list */}
          {selectedHive && selectedHive.steps.length > 0 && (
            <div className="px-4 py-3 border-b border-rule flex flex-col gap-2.5">
              {selectedHive.steps.map((step, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className={`mt-0.5 shrink-0 ${pal.text}`}>
                    <HiveCell size={13} />
                  </span>
                  <div className="min-w-0">
                    <span className="font-mono text-[12.5px] font-semibold text-fg">{step.agentName}</span>
                    {step.note && (
                      <div className="text-xs text-fg-dim mt-0.5 leading-[1.4]">{step.note}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Estimate — explicitly labelled as an estimate */}
          <div className="px-4 py-3 border-b border-rule flex items-center gap-4 font-mono text-xs text-fg-dim">
            <span className="inline-flex items-center gap-1.5">⏱ ~{estMin} min</span>
            <span>~${estCost}</span>
            <span className="text-fg-faint italic ml-auto">estimate</span>
          </div>

          {/* Launch CTA */}
          <div className="px-4 pb-4 pt-1">
            <button
              onClick={() => void handleLaunch()}
              disabled={!selectedHive || stepCount === 0 || missingAgents.length > 0}
              className={`w-full flex items-center justify-center gap-2.5 rounded-xl py-3 px-4 text-[15px] font-semibold text-white transition-opacity ${
                selectedHive && stepCount > 0 && missingAgents.length === 0
                  ? 'bg-accent hover:opacity-90 cursor-pointer shadow-[0_2px_0_rgba(0,0,0,0.18)]'
                  : 'bg-fg-faint cursor-not-allowed opacity-50'
              }`}
            >
              <span className="text-white">
                <HiveCell size={17} />
              </span>
              Launch the hive
            </button>
            {missingAgents.length > 0 && (
              <div className="mt-2 text-[11px] text-red-400 text-center leading-tight">
                {missingAgents.length} step{missingAgents.length !== 1 ? 's reference' : ' references'} agent{missingAgents.length !== 1 ? 's' : ''} that aren't installed: {missingAgents.join(', ')}
              </div>
            )}
            <div className="text-center mt-2 text-[11px] text-fg-faint">
              Auto-pauses on rate-limit · resumes on the next window reset
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
