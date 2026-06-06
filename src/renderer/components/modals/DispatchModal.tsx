import { useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SuperAgentModal } from './SuperAgentModal'
import { OrchestratorModal } from './OrchestratorModal'
import { RaceModal } from './RaceModal'
import { HiveManagerModal } from './HiveManagerModal'

/**
 * DispatchModal — single home for the "broadcast a prompt to multiple agents"
 * workflow. Four modes, differing only in topology:
 *   • Boss       — 1 boss + N specialists on the active tab (SuperAgent)
 *   • Orchestrate — a different sub-task per tab across N tabs (Orchestrator)
 *   • Race       — the same prompt to N tabs, pick a winner (Race)
 *   • Hives      — pre-baked swarm templates; "Launch" seeds Orchestrate
 *
 * Consolidates four former nav destinations into one surface. The live run
 * status (SuperAgentStatusBar / OrchestratorStatusPanel) is mounted at the App
 * level, so switching modes or navigating away never stops an in-flight run.
 *
 * Hives isn't a peer launcher — it feeds Orchestrate via
 * useOrchestrator.launchHive (writes pendingRoles), so its onLaunch just flips
 * this surface to the Orchestrate view where those roles are consumed.
 */

const noop = () => { /* page-mode close handler; nav-away closes implicitly */ }

export type DispatchMode = 'boss' | 'orchestrate' | 'race' | 'hives'

interface DispatchModalProps {
  open: boolean
  onClose: () => void
  variant?: 'overlay' | 'page'
  initialMode?: DispatchMode
}

const MODE_OPTIONS = [
  { key: 'boss' as const, label: 'Boss' },
  { key: 'orchestrate' as const, label: 'Orchestrate' },
  { key: 'race' as const, label: 'Race' },
  { key: 'hives' as const, label: 'Hives' },
]

const MODE_HINT: Record<DispatchMode, string> = {
  boss: '1 boss + N specialists on the active tab',
  orchestrate: 'a different sub-task per tab, across N tabs',
  race: 'the same prompt to N tabs — pick a winner',
  hives: 'pre-baked swarm templates · Launch seeds Orchestrate',
}

export function DispatchModal({ open, onClose: _onClose, variant = 'page', initialMode = 'boss' }: DispatchModalProps) {
  const [mode, setMode] = useState<DispatchMode>(initialMode)

  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  if (!open) return null
  void variant // always page-rendered; the surface owns its own chrome

  return (
    <div className="h-full w-full flex flex-col bg-bg">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line">
        <ViewTabs options={MODE_OPTIONS} active={mode} onChange={setMode} />
        <span className="text-[11px] text-fg-faint">{MODE_HINT[mode]}</span>
      </div>
      <div className="flex-1 min-h-0">
        {mode === 'boss' && <SuperAgentModal open onClose={noop} variant="page" />}
        {mode === 'orchestrate' && <OrchestratorModal open onClose={noop} variant="page" />}
        {mode === 'race' && <RaceModal open onClose={noop} variant="page" />}
        {mode === 'hives' && (
          <HiveManagerModal open onClose={noop} onLaunch={() => setMode('orchestrate')} variant="page" />
        )}
      </div>
    </div>
  )
}
