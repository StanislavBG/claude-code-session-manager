/**
 * Placeholder for the agent-in-the-loop observe/act panel — real allow/deny
 * action gating lands in the observe PRD (412+). This PRD only wires the
 * panel slot + layout. Titled "Claude session" per the design.
 */
import { useBrowserState } from '../../../state/browser'
import { PanelShell, SectionLabel } from './panel-primitives'

export function ObservePanel() {
  const setMode = useBrowserState((s) => s.setMode)

  return (
    <PanelShell title="Claude session" icon="sparkle" onClose={() => setMode('browse')}>
      <SectionLabel>Run context</SectionLabel>
      <div className="text-[12.5px] leading-relaxed text-fg-faint">
        The agent observe/act loop is coming in a later step.
      </div>
    </PanelShell>
  )
}
