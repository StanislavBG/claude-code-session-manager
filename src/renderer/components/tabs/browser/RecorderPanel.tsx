/**
 * Placeholder for the Recorder panel — real transport/steps/export UI lands
 * in PRD 409+. This PRD only wires the panel slot + layout.
 */
import { useBrowserState } from '../../../state/browser'
import { PanelShell, SectionLabel } from './panel-primitives'

export function RecorderPanel() {
  const setMode = useBrowserState((s) => s.setMode)

  return (
    <PanelShell title="Recorder" icon="record" onClose={() => setMode('browse')}>
      <SectionLabel>Steps</SectionLabel>
      <div className="text-[12.5px] leading-relaxed text-fg-faint">
        Step recording and export are coming in a later step.
      </div>
    </PanelShell>
  )
}
