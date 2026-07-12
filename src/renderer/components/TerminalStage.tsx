import { Terminal } from './Terminal'
import { TerminalControls } from './TerminalControls'
import { LiveTranscript } from './LiveTranscript'
import { useSessions } from '../state/sessions'

/**
 * TerminalStage — the "always mounted, visibility-toggled" terminal layer.
 * Extracted from MainPane so SplitAgentBrowser can render the SAME terminal
 * instance layer without a second <Terminal> mount for the active tab (which
 * would try to re-spawn the already-live PTY and fail with "session already
 * exists").
 */
interface TerminalStageProps {
  visible?: boolean
}

export function TerminalStage({ visible = true }: TerminalStageProps) {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  return (
    <div
      className="absolute inset-0"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      {activeTab ? (
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
        <NoSession />
      )}
      <LiveTranscript />
      {/* Terminal settings overlay — theme + font-size. Anchored to the
       *  terminal viewport (not MainPane) so the gear sits well below the
       *  TabBar's "v{__APP_VERSION__}" text. */}
      {visible && <TerminalControls />}
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
