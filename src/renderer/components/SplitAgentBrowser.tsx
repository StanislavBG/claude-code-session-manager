import { TerminalStage, NoSession } from './TerminalStage'
import { Browser } from './tabs/Browser'
import { useSessions } from '../state/sessions'

/**
 * SplitAgentBrowser — full-screen split view: the active session's agent
 * terminal on the left (1/3 width) and the Browser tab's web content on the
 * right (2/3 width), so a user can watch the agent drive the browser and
 * react in real time. Reuses TerminalStage (the same instance layer MainPane
 * renders) rather than mounting a second <Terminal> for the active tab.
 */
interface SplitAgentBrowserProps {
  onExit: () => void
}

export function SplitAgentBrowser({ onExit }: SplitAgentBrowserProps) {
  const activeTabId = useSessions((s) => s.activeTabId)

  return (
    <div className="h-full w-full flex flex-col bg-bg">
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-line shrink-0">
        <button
          onClick={onExit}
          className="text-[12px] text-fg-dim hover:text-fg px-2 py-1 rounded border border-line hover:bg-bg-hi/40"
        >
          Exit split view
        </button>
      </div>
      <div className="flex h-full w-full flex-1 min-h-0">
        <div className="relative w-1/3 min-w-0 border-r border-line">
          {activeTabId ? <TerminalStage /> : <NoSession />}
        </div>
        <div className="relative w-2/3 min-w-0">
          <Browser />
        </div>
      </div>
    </div>
  )
}
