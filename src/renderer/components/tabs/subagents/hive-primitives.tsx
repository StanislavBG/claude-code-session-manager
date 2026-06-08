import { useEffect, useState, type ReactNode } from 'react'
import type { Hive } from '../../../../preload/api'
import { useHives } from '../../../state/hives'
import { useOrchestrator } from '../../../state/orchestrator'
import { useActiveTab } from '../../../lib/useActiveTab'
import { toast } from '../../../state/toast'

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
function paletteAt(i: number): PaletteEntry {
  return HIVE_PALETTE[i % HIVE_PALETTE.length]
}

// Derive a time/cost estimate from a role count.
function hiveEstimate(roleCount: number) {
  return {
    estMin: Math.round(1.5 + roleCount),
    estCost: (0.15 * roleCount).toFixed(2),
  }
}

// A role is read-only if its prompt contains no explicit write-intent keywords.
function roleIsReadOnly(prompt: string): boolean {
  return !/\b(edit|write|create|modify|patch|implement|fix|update|save|delete|refactor|rename|generate|apply|add|replace|rewrite|scaffold|migrate)\b/i.test(
    prompt,
  )
}

function roleReturnsHint(label: string): string {
  const l = label.toLowerCase()
  if (l.includes('review')) return 'a prioritised list of findings'
  if (l.includes('test')) return 'a test suite'
  if (l.includes('plan')) return 'a design plan'
  if (l.includes('fix')) return 'a patched diff'
  if (l.includes('diagnos')) return 'a root-cause analysis'
  if (l.includes('repro')) return 'a minimal reproduction'
  if (l.includes('impl')) return 'production code'
  if (l.includes('securi')) return 'findings ranked by severity'
  if (l.includes('perf')) return 'a short hot-path report'
  return 'a findings digest'
}

// Hexagonal hive-cell SVG. Uses currentColor so the wrapping element's
// text-{color} class drives the fill.
function HiveCell({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="block shrink-0" aria-hidden>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="currentColor" />
    </svg>
  )
}

// Read-only / can-edit chip shown in the "What will happen" role list.
function ToolChip({ readOnly }: { readOnly: boolean }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-medium rounded border ${
      readOnly ? 'border-sage text-sage bg-bg' : 'border-butter text-fg-dim bg-bg'
    }`}>
      {readOnly ? 'read-only' : 'can edit'}
    </span>
  )
}

// Stable tab definitions hoisted to module level to avoid re-allocation per render.
const HIVE_TABS: { id: 'launch' | 'live' | 'configured' | 'library'; label: string }[] = [
  { id: 'launch', label: 'Launch' },
  { id: 'live', label: 'Live' },
  { id: 'configured', label: 'Configured' },
  { id: 'library', label: 'Library' },
]

// Sub-tab bar: Launch | Live | Configured | Library.
export function HiveSubTabs({
  value,
  onChange,
}: {
  value: 'launch' | 'live' | 'configured' | 'library'
  onChange: (v: 'launch' | 'live' | 'configured' | 'library') => void
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

// Numbered step header used in the Launch view.
function StepHeader({ n, title, hint }: { n: string; title: string; hint: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2.5">
        <span className="w-[22px] h-[22px] rounded-[7px] bg-accent text-white grid place-items-center font-mono text-xs font-bold shrink-0">
          {n}
        </span>
        <span className="font-serif text-[22px] font-semibold text-fg leading-tight">{title}</span>
      </div>
      <p className="mt-1.5 mb-0 ml-8 text-xs text-fg-dim leading-[1.45] max-w-[560px]">{hint}</p>
    </div>
  )
}

// Fan-out diagram: main session → N role cells → single digest.
function FanoutDiagram({ hive, pal }: { hive: Hive; pal: PaletteEntry }) {
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

      {/* Fan of roles */}
      <div className="flex flex-col gap-1.5 min-w-0">
        {hive.roles.map((role, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-8 border-t border-rule shrink-0" />
            <div className="flex items-center gap-2 bg-hi border border-line rounded-lg px-2.5 py-1 flex-1 min-w-0">
              <span className={`shrink-0 ${pal.text}`}>
                <HiveCell size={11} />
              </span>
              <span className="font-mono text-[11.5px] text-fg font-medium truncate">{role.label}</span>
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
  hive: Hive
  paletteIndex: number
  active: boolean
  onClick: () => void
}) {
  const pal = paletteAt(paletteIndex)
  const { estMin, estCost } = hiveEstimate(hive.roles.length)

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
        {hive.roles.map((role, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 bg-elev border border-line rounded-[7px] px-2 py-0.5"
          >
            <span className={pal.text}>
              <HiveCell size={10} />
            </span>
            <span className="font-mono text-[11px] text-fg-dim">{role.label}</span>
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
  onLaunchHive,
  onSwitchToLive,
}: {
  onLaunchHive?: () => void
  onSwitchToLive: () => void
}) {
  const list = useHives((s) => s.list)
  const loadHives = useHives((s) => s.load)
  const launchHive = useOrchestrator((s) => s.launchHive)
  const activeTab = useActiveTab()

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [target, setTarget] = useState('')

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
  const selectedHive = selectedIndex >= 0 ? list[selectedIndex] : null
  const pal = paletteAt(selectedIndex >= 0 ? selectedIndex : 0)

  const roleCount = selectedHive?.roles.length ?? 0
  const { estMin, estCost } = hiveEstimate(roleCount)

  // Derive the project label from the active tab's working directory.
  const cwdParts = activeTab?.cwd?.split('/').filter(Boolean) ?? []
  const projectLabel = cwdParts[cwdParts.length - 1] ?? 'no active project'

  const handleLaunch = () => {
    if (!selectedHive) return
    if (selectedHive.roles.length === 0) {
      toast.warn('This hive has no roles to launch.')
      return
    }
    // Pass the user's target brief as the plan so every role receives it
    // via the orchestrator's plan box (the only brief field in the API).
    launchHive({
      name: selectedHive.name,
      defaultPlan: target.trim() || selectedHive.defaultPlan,
      roles: selectedHive.roles.map((r) => ({ label: r.label, prompt: r.prompt })),
    })
    // When onLaunchHive navigates away from Subagents, calling onSwitchToLive
    // would set state on an unmounted component (no-op in React 18 but wasteful).
    // Only switch the sub-tab when there is no navigation callback.
    if (onLaunchHive) {
      onLaunchHive()
    } else {
      onSwitchToLive()
    }
  }

  const allReadOnly =
    !!selectedHive && selectedHive.roles.length > 0 && selectedHive.roles.every((r) => roleIsReadOnly(r.prompt))

  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_380px] gap-6 p-6 xl:p-9 items-start">
      {/* ── LEFT: build the hive ── */}
      <div>
        {/* Step 1: pick a recipe */}
        <div className="mb-7">
          <StepHeader
            n="1"
            title="Pick a recipe"
            hint="A preset bundle of subagents. Fire it at a target and each one works in parallel, in isolation."
          />
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
        </div>

        {/* Step 2: aim it */}
        <div>
          <StepHeader
            n="2"
            title="Aim it at a target"
            hint="What should the hive look at? Be specific — each agent gets this as its brief."
          />
          <div className="bg-hi border border-line rounded-xl p-1 mb-3">
            <textarea
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              spellCheck={false}
              placeholder="Describe what the hive should focus on…"
              rows={3}
              className="w-full resize-y border-0 outline-none bg-transparent px-3.5 py-3 text-fg text-sm leading-relaxed placeholder:text-fg-faint"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
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
              <strong className={pal.text}>{roleCount} agent{roleCount !== 1 ? 's' : ''}</strong>
              {' '}read your code in parallel — each in its own context — and hand back a single digest.
              {allReadOnly && <> Nothing is written without your say-so.</>}
            </p>
          </div>

          {/* Fan-out diagram */}
          {selectedHive && (
            <div className="px-4 py-3 border-b border-rule">
              <FanoutDiagram hive={selectedHive} pal={pal} />
            </div>
          )}

          {/* Per-role clarity */}
          {selectedHive && selectedHive.roles.length > 0 && (
            <div className="px-4 py-3 border-b border-rule flex flex-col gap-2.5">
              {selectedHive.roles.map((role, i) => {
                const readOnly = roleIsReadOnly(role.prompt)
                const returns = roleReturnsHint(role.label)
                return (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className={`mt-0.5 shrink-0 ${pal.text}`}>
                      <HiveCell size={13} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[12.5px] font-semibold text-fg">{role.label}</span>
                        <ToolChip readOnly={readOnly} />
                      </div>
                      <div className="text-xs text-fg-dim mt-0.5 leading-[1.4]">
                        Returns {returns}.
                      </div>
                    </div>
                  </div>
                )
              })}
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
              onClick={handleLaunch}
              disabled={!selectedHive || roleCount === 0}
              className={`w-full flex items-center justify-center gap-2.5 rounded-xl py-3 px-4 text-[15px] font-semibold text-white transition-opacity ${
                selectedHive && roleCount > 0
                  ? 'bg-accent hover:opacity-90 cursor-pointer shadow-[0_2px_0_rgba(0,0,0,0.18)]'
                  : 'bg-fg-faint cursor-not-allowed opacity-50'
              }`}
            >
              <span className="text-white">
                <HiveCell size={17} />
              </span>
              Launch the hive
            </button>
            <div className="text-center mt-2 text-[11px] text-fg-faint">
              Auto-pauses on rate-limit · resumes on the next window reset
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
