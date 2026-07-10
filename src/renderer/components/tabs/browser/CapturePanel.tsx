/**
 * Placeholder for the Capture DOM panel — the real selection/mode/export UI
 * lands in PRD 403+. This PRD only wires the panel slot + layout.
 */
import { useBrowserState } from '../../../state/browser'
import { PanelShell, SectionLabel } from './panel-primitives'

export function CapturePanel() {
  const setMode = useBrowserState((s) => s.setMode)

  return (
    <PanelShell title="Capture" icon="target" onClose={() => setMode('browse')}>
      <SectionLabel>Selection</SectionLabel>
      <div className="text-[12.5px] leading-relaxed text-fg-faint">
        The element picker and capture pipeline are coming in a later step.
      </div>
    </PanelShell>
  )
}
