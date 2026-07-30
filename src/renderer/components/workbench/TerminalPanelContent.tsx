import { TerminalStage } from '../TerminalStage'
import { useLayout } from '../../state/layout'

/**
 * Content for the 'terminal' dockview panel. Self-subscribes to the layout
 * store rather than taking `visible` as a params prop, so TerminalStage
 * (the singleton PTY-backed xterm layer) stays correct even though the
 * terminal panel — added once with `renderer: 'always'` — is never
 * re-mounted or handed fresh params by Workbench after its first open.
 */
export function TerminalPanelContent() {
  const isFocused = useLayout((s) => s.focusedPanelId === 'terminal')
  return <TerminalStage visible={isFocused} />
}
