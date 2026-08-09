import { Terminal } from './Terminal'
import { LiveTranscript } from './LiveTranscript'
import { EpicsWorkspace } from './epics/EpicsWorkspace'
import { useSessions } from '../state/sessions'
import { useLayout } from '../state/layout'

/**
 * TerminalStage — the "always mounted, visibility-toggled" terminal layer.
 * Extracted from MainPane so the SAME terminal instance layer can be reused
 * without a second <Terminal> mount for the active tab (which would try to
 * re-spawn the already-live PTY and fail with "session already exists").
 */
interface TerminalStageProps {
  visible?: boolean
}

export function TerminalStage({ visible = true }: TerminalStageProps) {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  // Explicit request for the workspace (Epics nav), independent of selection.
  // Previously this was inferred from `activeTab === null`, which forced nav
  // to deselect the top tab to show the workspace — see layout.ts.
  const epicsWorkspaceOpen = useLayout((s) => s.epicsWorkspaceOpen)
  const showWorkspace = epicsWorkspaceOpen || !activeTab

  return (
    <div
      className="absolute inset-0"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      {!showWorkspace ? (
        tabs.map((t) => (
          <div
            key={`${t.id}-${t.generation}`}
            className="absolute inset-0"
            // 'inherit', not 'visible': an explicit `visible` on a child
            // OVERRIDES the outer layer's `hidden` (CSS visibility is
            // per-element), leaving the active tab focusable/"visible"
            // underneath whatever non-terminal screen is painted on top.
            style={{ visibility: t.id === activeTabId ? 'inherit' : 'hidden' }}
          >
            <Terminal tabId={t.id} cwd={t.cwd} />
          </div>
        ))
      ) : (
        // Epics workspace (PRD 829): the two-pane Epic queue + detail
        // surface, in place of the old bare "no active session" message.
        <EpicsWorkspace />
      )}
      <LiveTranscript />
      {/* No settings overlay here on purpose. The terminal theme + font size
       *  are ONE app-wide preference (lib/terminalSettings.ts) shared by every
       *  xterm in the app; a gear pinned inside this pane framed it as a
       *  property of the session you were looking at. It is edited from Home's
       *  "Terminal appearance" card instead. */}
    </div>
  )
}

export function NoSession() {
  return (
    <div className="h-full flex items-center justify-center text-fg-faint text-xs">
      <div className="text-center">
        <div className="mb-2">no active session</div>
        <div>click <span className="text-fg-dim">+ new session</span> in the sidebar to start one</div>
      </div>
    </div>
  )
}
