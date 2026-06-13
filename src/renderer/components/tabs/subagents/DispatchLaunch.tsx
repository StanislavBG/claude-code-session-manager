import { useMemo, useState } from 'react'
import { Button } from '../../ui/Button'
import { Tooltip } from '../../ui/Tooltip'
import { useSessions } from '../../../state/sessions'
import { useOrchestrator } from '../../../state/orchestrator'
import { useRace } from '../../../state/race'
import { useSuperAgent, type SuperAgentDepth } from '../../../state/superagent'
import { useDispatch, type Topology } from '../../../state/dispatch'
import { toast } from '../../../state/toast'
import { LaunchView } from './hive-primitives'

/**
 * DispatchLaunch — the single Launch surface for the Subagents tab.
 *
 * One shared **brief** (state/dispatch.ts) sits at the top and is reused by
 * every topology, so the user types the goal once and never re-enters it when
 * switching between Hive / Orchestrate / Race / Boss. Each topology adds only
 * its own *secondary* config (recipe, per-tab sub-tasks, participants, or
 * specialist knobs) and its own Launch button. Launching hands off to the Live
 * sub-tab; the running run is owned by the per-topology stores.
 */

const TOPOLOGY_OPTIONS: { key: Topology; label: string; hint: string }[] = [
  { key: 'hive', label: 'Hive', hint: 'A preset bundle of subagents, fanned out in parallel' },
  { key: 'orchestrate', label: 'Orchestrate', hint: 'A different sub-task per tab, across N tabs' },
  { key: 'race', label: 'Race', hint: 'The same brief to N tabs — pick a winner' },
  { key: 'boss', label: 'Boss', hint: '1 boss + N specialists on the active tab' },
]

const BRIEF_PLACEHOLDER: Record<Topology, string> = {
  hive: 'What should the hive look at? Each agent gets this as its brief.',
  orchestrate: 'The parent goal you are fanning out across tabs.',
  race: 'The prompt every participant receives.',
  boss: 'What should Claude build, fix, or investigate?',
}

export function DispatchLaunch({ onSwitchToLive }: { onSwitchToLive: () => void }) {
  const brief = useDispatch((s) => s.brief)
  const setBrief = useDispatch((s) => s.setBrief)
  const topology = useDispatch((s) => s.topology)
  const setTopology = useDispatch((s) => s.setTopology)

  return (
    <div className="p-6 xl:p-9 max-w-[1100px] mx-auto">
      {/* ── Shared brief — typed once, reused by every topology ── */}
      <div className="mb-5">
        <label className="block text-[11px] font-bold tracking-[0.8px] uppercase text-fg-faint mb-1.5">
          Brief
        </label>
        <div className="bg-hi border border-line rounded-xl p-1">
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            spellCheck={false}
            data-testid="dispatch-brief"
            placeholder={BRIEF_PLACEHOLDER[topology]}
            rows={3}
            className="w-full resize-y border-0 outline-none bg-transparent px-3.5 py-3 text-fg text-sm leading-relaxed placeholder:text-fg-faint"
          />
        </div>
        <p className="mt-1.5 mb-0 text-xs text-fg-faint">
          One brief, reused across every shape below. Switching shapes keeps what you typed.
        </p>
      </div>

      {/* ── Topology selector ── */}
      <div className="mb-6">
        <div className="inline-flex gap-1 bg-elev p-1 rounded-xl ring-1 ring-line flex-wrap">
          {TOPOLOGY_OPTIONS.map((t) => {
            const active = topology === t.key
            return (
              <Tooltip key={t.key} content={t.hint}>
                <button
                  onClick={() => setTopology(t.key)}
                  className={`px-4 py-1.5 rounded-[9px] text-[13.5px] transition-colors ${
                    active
                      ? 'bg-hi ring-1 ring-line shadow-sm text-fg font-semibold'
                      : 'font-medium text-fg-dim hover:text-fg'
                  }`}
                >
                  {t.label}
                </button>
              </Tooltip>
            )
          })}
        </div>
      </div>

      {/* ── Topology body ── */}
      {topology === 'hive' && <LaunchView onSwitchToLive={onSwitchToLive} />}
      {topology === 'orchestrate' && <OrchestrateForm brief={brief} onSwitchToLive={onSwitchToLive} />}
      {topology === 'race' && <RaceForm brief={brief} onSwitchToLive={onSwitchToLive} />}
      {topology === 'boss' && <BossForm brief={brief} onSwitchToLive={onSwitchToLive} />}
    </div>
  )
}

/* ─────────────────────────── Orchestrate ─────────────────────────── */

function OrchestrateForm({ brief, onSwitchToLive }: { brief: string; onSwitchToLive: () => void }) {
  const allTabs = useSessions((s) => s.tabs)
  const configure = useOrchestrator((s) => s.configure)
  const start = useOrchestrator((s) => s.start)
  const runningTabs = useMemo(() => allTabs.filter((t) => t.status === 'running'), [allTabs])

  const [rows, setRows] = useState<{ tabId: string; prompt: string }[]>([])
  const enoughTabs = runningTabs.length >= 2

  const addRow = () => {
    const used = new Set(rows.map((r) => r.tabId))
    const next = runningTabs.find((t) => !used.has(t.id))
    if (!next) {
      toast.warn('All running tabs are already assigned a sub-task.')
      return
    }
    setRows([...rows, { tabId: next.id, prompt: '' }])
  }
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i))
  const changeRow = (i: number, patch: Partial<{ tabId: string; prompt: string }>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const canStart =
    brief.trim().length > 0 &&
    rows.length >= 2 &&
    rows.every((r) => r.prompt.trim().length > 0) &&
    new Set(rows.map((r) => r.tabId)).size === rows.length

  const handleStart = () => {
    if (!canStart) return
    const tabById = new Map(runningTabs.map((t) => [t.id, t]))
    const picks = rows
      .map((r) => {
        const tab = tabById.get(r.tabId)
        return tab ? { tabId: tab.id, label: tab.label, presetId: tab.presetId, prompt: r.prompt.trim() } : null
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
    if (picks.length < 2) {
      toast.warn('Orchestrator needs at least 2 running tabs with sub-tasks.')
      return
    }
    configure(brief.trim(), picks)
    start()
    onSwitchToLive()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase tracking-wider text-fg-faint">
          Sub-tasks — assign one to each tab
        </label>
        <span className="text-[10px] text-fg-faint">
          {rows.length} task{rows.length !== 1 ? 's' : ''} · {runningTabs.length} running tab{runningTabs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {!enoughTabs ? (
        <div className="text-xs text-fg-dim p-3 border border-line rounded bg-bg">
          Orchestrate needs at least 2 running tabs. Open more sessions first.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-start gap-2 bg-bg border border-line rounded p-2">
              <span className="text-[10px] text-accent font-mono shrink-0 mt-2">T{i + 1}</span>
              <select
                value={row.tabId}
                onChange={(e) => changeRow(i, { tabId: e.target.value })}
                className="bg-bg border border-line rounded px-2 py-1 text-xs text-fg shrink-0 max-w-[180px]"
              >
                {runningTabs.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
              <textarea
                value={row.prompt}
                onChange={(e) => changeRow(i, { prompt: e.target.value })}
                placeholder={`Sub-task for ${runningTabs.find((t) => t.id === row.tabId)?.label ?? 'tab'}…`}
                rows={2}
                className="flex-1 min-w-0 bg-bg border border-line rounded px-2 py-1 text-xs text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none font-mono"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label="Remove sub-task"
                className="text-fg-faint hover:text-red-400 px-1.5 py-0.5 text-sm"
              >
                ✕
              </button>
            </div>
          ))}
          <Button variant="default" onClick={addRow}>+ Add sub-task</Button>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="primary" onClick={handleStart} disabled={!canStart}>Start orchestrator</Button>
      </div>
      <p className="text-[10px] text-fg-faint">Uses existing running tabs. The brief above is the parent goal each sub-task serves.</p>
    </div>
  )
}

/* ─────────────────────────────── Race ─────────────────────────────── */

function RaceForm({ brief, onSwitchToLive }: { brief: string; onSwitchToLive: () => void }) {
  const tabs = useSessions((s) => s.tabs)
  const configure = useRace((s) => s.configure)
  const begin = useRace((s) => s.begin)
  const runningTabs = useMemo(() => tabs.filter((t) => t.status === 'running'), [tabs])

  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const pickedCount = Object.values(picked).filter(Boolean).length
  const canStart = brief.trim().length > 0 && pickedCount >= 2
  const toggle = (id: string) => setPicked({ ...picked, [id]: !picked[id] })

  const handleStart = () => {
    if (!canStart) return
    const picks = runningTabs
      .filter((t) => picked[t.id])
      .map((t) => ({ tabId: t.id, label: t.label, presetId: t.presetId }))
    if (picks.length < 2) {
      toast.warn('Race needs at least 2 running tabs.')
      return
    }
    const trimmed = brief.trim()
    configure(trimmed, picks)
    for (const p of picks) {
      try {
        window.api.pty.write({ tabId: p.tabId, data: trimmed + '\r' })
      } catch (e) {
        toast.error(`Failed to send race prompt to ${p.label}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    begin()
    onSwitchToLive()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase tracking-wider text-fg-faint">
          Participants — pick 2+ running tabs
        </label>
        <span className="text-[10px] text-fg-faint">{pickedCount} selected</span>
      </div>
      {runningTabs.length === 0 ? (
        <div className="text-xs text-fg-dim p-3 border border-line rounded bg-bg">
          No running tabs available. Open at least 2 sessions first, then return here.
        </div>
      ) : (
        <div className="max-h-64 overflow-auto border border-line rounded divide-y divide-line">
          {runningTabs.map((t) => (
            <label key={t.id} className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-bg-hi cursor-pointer">
              <input type="checkbox" checked={!!picked[t.id]} onChange={() => toggle(t.id)} className="accent-accent" />
              <span className="text-fg truncate flex-1">{t.label}</span>
              {t.presetId && <span className="text-fg-faint text-[10px] font-mono">{t.presetId}</span>}
              <span className="text-fg-faint text-[10px] font-mono">{t.cwd.split('/').filter(Boolean).pop()}</span>
            </label>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="primary" onClick={handleStart} disabled={!canStart}>Start race</Button>
      </div>
      <p className="text-[10px] text-fg-faint">Uses existing running tabs. The brief above is sent verbatim to every participant.</p>
    </div>
  )
}

/* ─────────────────────────────── Boss ─────────────────────────────── */

const DEPTHS: { value: SuperAgentDepth; label: string; help: string }[] = [
  { value: 'quick', label: 'Quick', help: 'One-shot specialist work, surface-level.' },
  { value: 'standard', label: 'Standard', help: 'Moderate detail, one or two iterations.' },
  { value: 'deep', label: 'Deep', help: 'Multi-step plans per specialist, recurse on findings.' },
]

function BossForm({ brief, onSwitchToLive }: { brief: string; onSwitchToLive: () => void }) {
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const sessionRunning = activeTab?.status === 'running'
  const run = useSuperAgent((s) => (activeTabId ? s.tabs[activeTabId]?.run : null))
  const alreadyRunning = run?.status === 'running'

  const [specialistCount, setSpecialistCount] = useState(3)
  const [depth, setDepth] = useState<SuperAgentDepth>('standard')
  const [starting, setStarting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const startDisabled = starting || !brief.trim() || !activeTabId || !sessionRunning

  const handleStart = async () => {
    setLocalError(null)
    if (!activeTabId) return setLocalError('No active session — start a terminal tab first.')
    if (!sessionRunning) return setLocalError('Active session is not running. Restart it or pick another tab.')
    if (!brief.trim()) return setLocalError('Type a brief above first.')
    setStarting(true)
    try {
      const res = await window.api.superagent.start({
        tabId: activeTabId,
        prompt: brief.trim(),
        specialistCount,
        depth,
      })
      if (!res.ok) {
        setLocalError(res.error ?? 'Failed to start.')
        setStarting(false)
        return
      }
      toast.info(`Boss launched — ${specialistCount} specialist(s), ${depth} depth.`)
      setStarting(false)
      onSwitchToLive()
    } catch (e: unknown) {
      setLocalError(e instanceof Error ? e.message : String(e))
      setStarting(false)
    }
  }

  const handleStop = async () => {
    if (!activeTabId) return
    try {
      await window.api.superagent.stop(activeTabId)
      toast.info('Boss run stopped.')
    } catch (e: unknown) {
      toast.error(`Stop failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-fg-dim leading-relaxed">
        Claude acts as a "boss" on the <span className="text-fg">active tab</span>{activeTab ? ` (${activeTab.label})` : ''} —
        choosing specialist subagents, dispatching them via the Task tool, and reporting back to the terminal.
      </div>

      {alreadyRunning && (
        <div className="px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-300">
          A boss run is already in progress on this tab. Starting a new one will replace it
          (Claude may still be working in the terminal — stop or Ctrl-C there if needed).
        </div>
      )}

      <div className="flex items-end gap-6">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-fg-faint mb-1">Specialists</label>
          <div className="flex items-center gap-2">
            <input
              type="range" min={1} max={8} value={specialistCount}
              onChange={(e) => setSpecialistCount(parseInt(e.target.value, 10))}
              className="w-28" aria-label="Specialist count" data-testid="superagent-specialists"
            />
            <span className="font-mono text-xs text-fg w-4 text-right">{specialistCount}</span>
          </div>
        </div>
        <div className="flex-1">
          <label className="block text-[10px] uppercase tracking-wider text-fg-faint mb-1">Depth</label>
          <div className="flex gap-1">
            {DEPTHS.map((d) => (
              <Tooltip key={d.value} content={d.help}>
                <button
                  type="button"
                  onClick={() => setDepth(d.value)}
                  className={`flex-1 py-1.5 px-2 text-xs rounded border transition-colors ${
                    depth === d.value
                      ? 'bg-bg-hi text-fg border-accent'
                      : 'text-fg-dim border-line hover:text-fg hover:bg-bg-hi/60'
                  }`}
                  data-testid={`superagent-depth-${d.value}`}
                >
                  {d.label}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>

      {localError && (
        <div className="px-3 py-2 rounded border border-red-500/40 bg-red-500/10 text-[11px] text-red-300" data-testid="superagent-error">
          {localError}
        </div>
      )}
      {!sessionRunning && (
        <div className="text-[11px] text-fg-faint">⚠ Active session is not running. Boss needs a live PTY to write to.</div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        {alreadyRunning && <Button onClick={handleStop} variant="danger">Stop current run</Button>}
        <Button onClick={handleStart} disabled={startDisabled} variant="primary">
          {starting ? 'Launching…' : 'Launch boss'}
        </Button>
      </div>
    </div>
  )
}
