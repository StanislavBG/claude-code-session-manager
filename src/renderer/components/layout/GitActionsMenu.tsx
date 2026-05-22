import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessions } from '../../state/sessions'

// Ported from OneWave-AI/ClaudeCodeUnleashed
// (src/renderer/components/layout/Header.tsx gitActions array).
// Prompts are copied VERBATIM from Unleashed — the value of this feature is
// the exact wording. Do not paraphrase.
const GIT_ACTIONS: Array<{ id: string; label: string; prompt: string }> = [
  {
    id: 'commit',
    label: 'Commit Changes',
    prompt:
      'Run git status to see changes, then commit all changes with a descriptive commit message that explains what was changed and why. Use conventional commit format if appropriate.',
  },
  {
    id: 'push',
    label: 'Push to Remote',
    prompt:
      'Push my commits to the remote repository. If the branch is not tracking a remote, set up tracking first with git push -u origin <branch>.',
  },
  {
    id: 'pr',
    label: 'Create Pull Request',
    prompt:
      'Create a pull request for my current branch. First check git status, then use gh pr create with a good title and description summarizing the changes.',
  },
]

const BRANCH_TTL_MS = 30_000
const branchCache = new Map<string, { value: string | null; ts: number }>()

/**
 * Dropdown that sends one of 3 git-related Claude prompts to the active
 * session's terminal. Ported from Unleashed; uses our pty.write IPC.
 */
export function GitActionsMenu() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const tab = tabs.find((t) => t.id === activeTabId) ?? null
  const cwd = tab?.cwd ?? null
  const tabStatus = tab?.status ?? null

  const [open, setOpen] = useState(false)
  const [branch, setBranch] = useState<string | null>(
    cwd ? branchCache.get(cwd)?.value ?? null : null,
  )
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!cwd) {
      setBranch(null)
      return
    }
    const load = async () => {
      const now = Date.now()
      const hit = branchCache.get(cwd)
      if (hit && now - hit.ts < BRANCH_TTL_MS) {
        if (!cancelled) setBranch(hit.value)
        return
      }
      try {
        const v = await window.api.app.gitBranch(cwd)
        if (cancelled) return
        branchCache.set(cwd, { value: v, ts: Date.now() })
        setBranch(v)
      } catch {
        if (cancelled) return
        branchCache.set(cwd, { value: null, ts: Date.now() })
        setBranch(null)
      }
    }
    load()
    const id = window.setInterval(load, BRANCH_TTL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [cwd])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!error) return
    const id = window.setTimeout(() => setError(null), 4000)
    return () => window.clearTimeout(id)
  }, [error])

  const sendPrompt = useCallback((prompt: string) => {
    const id = useSessions.getState().activeTabId
    const t = id ? useSessions.getState().tabs.find((x) => x.id === id) ?? null : null
    if (!t || t.status !== 'running') {
      setError('No active session — start a terminal first.')
      return
    }
    try {
      window.api.pty.write({ tabId: t.id, data: prompt + '\r' })
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const canSend = !!tab && tabStatus === 'running'

  return (
    <div ref={rootRef} className="relative shrink-0 self-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`px-2 h-7 flex items-center gap-1.5 text-xs rounded transition-colors ${
          open ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi/60'
        }`}
        title="Git actions — send a git prompt to the active session"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="git-actions-button"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        {branch && (
          <span className="font-mono text-[10px] text-fg-faint truncate max-w-[80px]" data-testid="git-actions-branch">
            {branch}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Git actions"
          data-testid="git-actions-menu"
          className="absolute right-0 top-full mt-1 z-50 w-56 bg-bg-elev border border-line rounded shadow-lg text-xs overflow-hidden"
        >
          <div className="px-3 py-1.5 border-b border-line text-[10px] uppercase tracking-wider text-fg-faint">
            Git Actions{' '}
            {branch && (
              <span className="text-fg-dim normal-case tracking-normal font-mono">({branch})</span>
            )}
          </div>
          {GIT_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              onClick={() => sendPrompt(a.prompt)}
              disabled={!canSend}
              className="w-full text-left px-3 py-2 text-fg-dim hover:bg-bg-hi hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              data-testid={`git-actions-item-${a.id}`}
            >
              {a.label}
            </button>
          ))}
          {!canSend && (
            <div className="px-3 py-1.5 text-[10px] text-amber-400 border-t border-line">
              Start a session first
            </div>
          )}
          {error && (
            <div className="px-3 py-1.5 text-[10px] text-red-400 border-t border-line" data-testid="git-actions-error">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
