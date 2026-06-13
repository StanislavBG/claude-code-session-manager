import { useOrchestrator } from '../../../state/orchestrator'
import { useRace } from '../../../state/race'
import { OrchestratorRunView } from './OrchestratorRunView'
import { RaceView } from './RaceRunView'
import { toast } from '../../../state/toast'

/**
 * DispatchLive — surfaces any in-flight Orchestrate / Race run inside the
 * Subagents tab's Live sub-tab, reusing the run grids extracted from the
 * modals. Renders nothing when neither run is active, so the caller can fall
 * back to the per-tab Task-tool monitor (LiveAgentsPanel).
 *
 * Boss runs need no panel here — the app-level SuperAgentStatusBar already
 * surfaces them, and the specialists it spawns appear in LiveAgentsPanel.
 */
export function DispatchLive() {
  const orchStatus = useOrchestrator((s) => s.status)
  const raceStatus = useRace((s) => s.status)

  const orchActive = orchStatus === 'running' || orchStatus === 'paused'
  const raceActive = raceStatus === 'running' || raceStatus === 'finished'

  if (!orchActive && !raceActive) return null

  return (
    <div className="space-y-6">
      {orchActive && <OrchestrateRun />}
      {raceActive && <RaceRun />}
    </div>
  )
}

function OrchestrateRun() {
  const plan = useOrchestrator((s) => s.plan)
  const tasks = useOrchestrator((s) => s.tasks)
  const status = useOrchestrator((s) => s.status) as 'running' | 'paused'
  const pause = useOrchestrator((s) => s.pause)
  const resume = useOrchestrator((s) => s.resume)
  const nudgeAll = useOrchestrator((s) => s.nudgeAll)
  const stop = useOrchestrator((s) => s.stop)

  return (
    <section>
      <h3 className="text-[11px] font-bold tracking-[0.8px] uppercase text-fg-faint mb-2">🎼 Orchestrate</h3>
      <OrchestratorRunView
        plan={plan}
        tasks={tasks}
        status={status}
        onPause={pause}
        onResume={resume}
        onNudgeAll={nudgeAll}
        onStop={() => {
          stop()
          toast.info('Orchestrator stopped. Tabs continue working in their PTYs until Ctrl-C.')
        }}
      />
    </section>
  )
}

function RaceRun() {
  const participants = useRace((s) => s.participants)
  const winnerTabId = useRace((s) => s.winnerTabId)
  const status = useRace((s) => s.status) as 'running' | 'finished'
  const prompt = useRace((s) => s.prompt)
  const declareWinner = useRace((s) => s.declareWinner)

  return (
    <section>
      <h3 className="text-[11px] font-bold tracking-[0.8px] uppercase text-fg-faint mb-2">🏁 Race</h3>
      <RaceView
        participants={participants}
        winnerTabId={winnerTabId}
        status={status}
        prompt={prompt}
        onDeclareWinner={declareWinner}
      />
    </section>
  )
}
