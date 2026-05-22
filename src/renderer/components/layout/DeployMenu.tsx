import { useEffect, useRef, useState } from 'react'
import { useSessions } from '../../state/sessions'

// Ported from OneWave-AI/ClaudeCodeUnleashed
// src/renderer/components/layout/Header.tsx `deployActions` array.
interface DeployAction {
  id: string
  label: string
  prompt: string
}

const DEPLOY_ACTIONS: DeployAction[] = [
  {
    id: 'vercel',
    label: 'Deploy to Vercel',
    prompt:
      'Deploy this project to Vercel. First check if vercel CLI is installed (vercel --version), if not guide me to install it. Then run vercel deploy --prod to deploy. If this is a new project, run vercel link first.',
  },
  {
    id: 'gh-pages',
    label: 'GitHub Pages',
    prompt:
      'Deploy this project to GitHub Pages. Check the project type and build it if needed (npm run build), then deploy to the gh-pages branch. Use gh-pages package or manual git commands as appropriate for this project.',
  },
]

export function DeployMenu() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const canSend = !!activeTab && activeTab.status === 'running'

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const send = (action: DeployAction) => {
    setOpen(false)
    if (!activeTabId) return
    window.api.pty.write({ tabId: activeTabId, data: action.prompt + '\r' })
  }

  return (
    <div ref={rootRef} className="relative shrink-0 self-center">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!canSend}
        className={`px-2 h-7 flex items-center text-xs transition-colors rounded ${
          open ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi/60'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
        title={canSend ? 'Deploy actions' : 'Open a session to deploy'}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="deploy-menu-trigger"
      >
        <span aria-hidden="true">🚀</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Deploy options"
          className="absolute right-0 top-full mt-1 z-50 w-64 bg-bg-elev border border-line rounded shadow-lg text-xs"
          data-testid="deploy-menu"
        >
          <div className="px-3 py-1.5 border-b border-line text-[10px] uppercase tracking-wider text-fg-faint">
            Deploy
          </div>
          <ul className="py-1">
            {DEPLOY_ACTIONS.map((a) => (
              <li key={a.id}>
                <button
                  role="menuitem"
                  onClick={() => send(a)}
                  disabled={!canSend}
                  className="w-full text-left px-3 py-2 text-fg-dim hover:bg-bg-hi hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                  data-testid={`deploy-menu-item-${a.id}`}
                >
                  <span aria-hidden="true">🚀</span>
                  <span>{a.label}</span>
                </button>
              </li>
            ))}
          </ul>
          {!canSend && (
            <div className="px-3 py-2 border-t border-line text-fg-faint">
              Open and start a session to send a deploy prompt.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
