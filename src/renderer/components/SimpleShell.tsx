import { Terminal } from './Terminal'
import { RecordingStatus } from './RecordingStatus'
import { Toast } from './ui/Toast'
import { useSessions } from '../state/sessions'
import { useVoice } from '../state/voice'

/**
 * Simple mode (`npx claude-code-session-manager --simple`).
 *
 * A stripped single-terminal cockpit: no left nav, no tab bar, no config
 * surface — just one full-window `claude --dangerously-skip-permissions`
 * session in the launch directory. The session itself is created by App.tsx's
 * boot path (DEFAULT_PRESETS[0] is the skip-perms preset rooted at process.cwd),
 * so this component only owns the chrome-free layout.
 *
 * Privacy invariant (CLAUDE.md): RecordingStatus stays mounted so the recording
 * banner can never be hidden, even here. Toast remains so errors still surface.
 */
export function SimpleShell() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const isRecording = useVoice((s) => s.isRecording)

  return (
    <div className={`h-full w-full flex flex-col bg-bg text-fg text-sm ${isRecording ? 'pt-7' : ''}`}>
      <RecordingStatus />
      <div className="flex items-center gap-2 px-3 py-1 border-b border-white/5 text-[11px] text-fg/50 select-none">
        <span className="font-medium text-fg/70">simple mode</span>
        {activeTab && <span className="truncate">· {activeTab.cwd}</span>}
      </div>
      <div className="flex-1 min-h-0 relative">
        {activeTab ? (
          <Terminal key={`${activeTab.id}-${activeTab.generation}`} tabId={activeTab.id} cwd={activeTab.cwd} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-fg/40">Starting claude…</div>
        )}
      </div>
      <Toast />
    </div>
  )
}
