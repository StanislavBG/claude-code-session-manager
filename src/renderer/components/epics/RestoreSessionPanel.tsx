import { useEffect, useId, useState, type ReactNode } from 'react'
import type { PromptSessionsListRestorableResult, RestorableSession } from '../../../preload/api'
import { toast } from '../../state/toast'
import { formatAgo } from '../../lib/formatTime'

const DESCRIPTION =
  'Continue a Claude Code session already in this project instead of starting a fresh one. Its history is kept, your goal is sent as its next message, and it runs in the project checkout (no isolated worktree).'
const EMPTY_TEXT = 'No earlier Claude Code sessions in this project.'
const MISSING_API_TEXT = 'Restart the app to restore sessions'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing-api' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; sessions: RestorableSession[] }

const NO_SESSIONS: RestorableSession[] = []

// A preload older than this bundle never exposed the method: say "restart", never throw.
const hasListApi = () => typeof window.api?.promptSessions?.listRestorable === 'function'

// Main owns the shape; a row without a usable id is dropped rather than rendered as `-undefined`.
const isRow = (s: unknown): s is RestorableSession =>
  !!s && typeof s === 'object' && typeof (s as RestorableSession).sessionId === 'string' && (s as RestorableSession).sessionId !== ''

/** The one name a restorable session goes by — its title, else its first prompt — on one line. */
export function restorableSessionLabel(s: RestorableSession): string {
  const text = (typeof s.title === 'string' && s.title.trim()) || (typeof s.firstPrompt === 'string' && s.firstPrompt.trim()) || s.sessionId
  return text.replace(/\s+/g, ' ')
}

/** "5m ago · ⎇ main" — when the transcript was last written, and on which branch. */
export function restorableSessionMeta(s: RestorableSession, now: number): string {
  return [
    Number.isFinite(s.mtimeMs) ? formatAgo(s.mtimeMs, now) : null,
    s.gitBranch ? `⎇ ${s.gitBranch}` : null,
    s.headless ? 'headless' : null,
  ].filter(Boolean).join(' · ')
}

/**
 * New Session card, advanced face: pick one of this project's earlier Claude
 * Code sessions (main's listRestorable — sessions no Epic owns yet) for the new
 * Epic to continue, or keep the default fresh session. Loads once per cwd,
 * only while mounted (the card mounts it only while advanced is open); every
 * failure renders as a state, never a throw. `readOnly` (an edited draft) never
 * lists: a saved draft keeps the session it was minted with.
 */
export function RestoreSessionPanel({
  cwd,
  excludeIds,
  selectedId,
  onSelect,
  readOnly = false,
  readOnlyNote,
}: {
  cwd: string
  /** Session ids already open as tabs (tab id = claude session id) — never offered. */
  excludeIds: string[]
  selectedId: string | null
  onSelect: (s: RestorableSession | null) => void
  readOnly?: boolean
  readOnlyNote?: string
}) {
  const radioName = useId()
  const [state, setState] = useState<LoadState>(() => (hasListApi() ? { kind: 'loading' } : { kind: 'missing-api' }))
  const [showHeadless, setShowHeadless] = useState(false)

  useEffect(() => {
    if (readOnly) return
    if (!hasListApi()) {
      setState({ kind: 'missing-api' })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    const fail = (e: unknown) => {
      if (cancelled) return
      const message = e instanceof Error ? e.message : String(e)
      toast.error(`Could not list earlier Claude Code sessions: ${message}`)
      setState({ kind: 'error', message })
    }
    const done = (r: PromptSessionsListRestorableResult | null | undefined) => {
      if (cancelled) return
      setState({ kind: 'loaded', sessions: Array.isArray(r?.sessions) ? r.sessions.filter(isRow) : NO_SESSIONS })
    }
    try {
      Promise.resolve(window.api.promptSessions.listRestorable({ cwd })).then(done, fail)
    } catch (e) {
      fail(e)
    }
    return () => { cancelled = true }
  }, [cwd, readOnly])

  const sessions = state.kind === 'loaded' ? state.sessions : NO_SESSIONS
  const openable = sessions.filter((s) => !excludeIds.includes(s.sessionId))
  // The picked row always shows, even when it is a headless run the checkbox would hide.
  const visible = openable.filter((s) => !s.headless || showHeadless || s.sessionId === selectedId)
  const headlessCount = openable.filter((s) => s.headless).length
  const hiddenCount = openable.length - visible.length
  const now = Date.now()

  let body: ReactNode
  if (readOnly) {
    body = (
      <>
        {selectedId ? (
          <div data-testid="restore-session-readonly-id" className="font-mono text-[11px] text-fg-dim">
            Continues Claude Code session <span className="text-fg">{selectedId}</span>
          </div>
        ) : null}
        {readOnlyNote ? (
          <p data-testid="restore-session-readonly-note" className="mt-1 text-[11.5px] leading-[1.4] text-fg-faint">
            {readOnlyNote}
          </p>
        ) : null}
      </>
    )
  } else if (state.kind === 'missing-api') {
    body = <p data-testid="restore-session-missing-api" className="text-[11.5px] text-fg-dim">{MISSING_API_TEXT}</p>
  } else if (state.kind === 'loading') {
    body = <p data-testid="restore-session-loading" className="text-[11.5px] text-fg-faint">Reading this project's Claude Code sessions…</p>
  } else if (state.kind === 'error') {
    body = (
      <p data-testid="restore-session-error" className="text-[11.5px] text-fg-dim">
        Could not list earlier sessions: {state.message}
      </p>
    )
  } else if (openable.length === 0) {
    body = <p data-testid="restore-session-empty" className="text-[11.5px] text-fg-faint">{EMPTY_TEXT}</p>
  } else {
    body = (
      <div role="radiogroup" aria-label="Restore a session">
        <label className="flex cursor-pointer items-start gap-2 py-1">
          <input
            type="radio"
            name={radioName}
            checked={selectedId === null}
            onChange={() => onSelect(null)}
            data-testid="restore-session-option-none"
            className="mt-0.5"
          />
          <span className="text-[12.5px] font-medium text-fg">Start a fresh session</span>
        </label>
        <div className="max-h-[220px] overflow-y-auto">
          {visible.map((s) => (
            <label key={s.sessionId} className="flex cursor-pointer items-start gap-2 py-1">
              <input
                type="radio"
                name={radioName}
                checked={selectedId === s.sessionId}
                onChange={() => onSelect(s)}
                data-testid={`restore-session-option-${s.sessionId}`}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-fg">{restorableSessionLabel(s)}</span>
                <span className="block font-mono text-[10.5px] text-fg-faint">{restorableSessionMeta(s, now)}</span>
                {s.recentlyActive && (
                  <span
                    data-testid={`restore-session-active-warning-${s.sessionId}`}
                    className="mt-1 block rounded-md border border-honey/30 bg-honey/15 px-2 py-1 text-[11px] leading-[1.4] text-fg-dim"
                  >
                    Written in the last 2 minutes — it may still be open. Close that session in its terminal first.
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
        {headlessCount > 0 && (
          <label className="mt-1.5 flex cursor-pointer items-center gap-2 border-t border-rule pt-1.5 text-[11.5px] text-fg-faint">
            <input
              type="checkbox"
              data-testid="restore-session-show-headless"
              checked={showHeadless}
              onChange={(e) => setShowHeadless(e.target.checked)}
            />
            <span>
              Show headless runs (claude -p){hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
            </span>
          </label>
        )}
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-[10px] border border-line bg-bg px-3 py-2.5" data-testid="new-epic-restore-panel">
      <div className="mb-1 text-[12.5px] font-semibold text-fg">Restore a session</div>
      <p className="mb-1.5 text-[11.5px] leading-[1.4] text-fg-faint">{DESCRIPTION}</p>
      {body}
    </div>
  )
}
