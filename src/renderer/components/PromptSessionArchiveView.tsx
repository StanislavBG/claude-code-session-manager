import { useEffect, useState } from 'react'
import { promptSessionArchivePath, type PromptSessionArchive } from '../state/promptSessions'

/**
 * Read-only viewer for a completed PromptSession's on-disk archive (PRD 805)
 * — reads session-manager-operations/prompt-sessions/<id>.json directly via
 * config:read-json. Deliberately does NOT import useChat/hydrate or touch
 * chat.ts/pty.cjs in any way: opening history must never spawn a new pty or
 * chatRunner job for a session whose claudeSessionId is dead.
 */
interface Props {
  cwd: string
  promptSessionId: string
}

export function PromptSessionArchiveView({ cwd, promptSessionId }: Props) {
  const [archive, setArchive] = useState<PromptSessionArchive | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setArchive(null)
    setError(null)
    const path = promptSessionArchivePath(cwd, promptSessionId)
    window.api.config
      .readJson(path)
      .then((result) => {
        if (cancelled) return
        if (!result.exists || result.parseError || !result.data) {
          setError(result.parseError ?? result.error ?? 'archive not found')
          return
        }
        setArchive(result.data as PromptSessionArchive)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [cwd, promptSessionId])

  if (error) {
    return (
      <div data-testid="prompt-session-archive-view" className="flex h-full items-center justify-center text-sm text-fg-faint">
        Could not load archive: {error}
      </div>
    )
  }

  if (!archive) {
    return (
      <div data-testid="prompt-session-archive-view" className="flex h-full items-center justify-center text-sm text-fg-faint">
        Loading archive…
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg" data-testid="prompt-session-archive-view">
      <div className="flex items-center justify-between border-b border-rule px-4 py-2">
        <div className="min-w-0">
          <div className="font-serif text-base text-fg truncate" title={archive.session.goalText}>
            {archive.session.goalText}
          </div>
          <div className="truncate font-mono text-[11px] text-fg-dim" title={archive.session.cwd}>
            {archive.session.cwd} · archived {archive.archivedAt}
          </div>
        </div>
        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-bg-hi text-fg-faint">
          Completed (read-only)
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4" data-testid="prompt-session-archive-events">
        <div className="flex flex-col gap-2">
          {archive.events.map((event) => (
            <div
              key={event.id}
              data-testid="prompt-session-archive-event"
              data-kind={event.kind}
              className="rounded-md border border-line bg-bg-elev px-3 py-2"
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
                {event.kind}
                {event.prdSlug ? ` · ${event.prdSlug}` : ''}
              </div>
              {event.text && <div className="mt-1 whitespace-pre-wrap text-[12.5px] text-fg">{event.text}</div>}
            </div>
          ))}
        </div>

        {archive.transcript && (
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-[0.05em] text-fg-faint uppercase">
              Transcript
            </div>
            <pre
              data-testid="prompt-session-archive-transcript"
              className="whitespace-pre-wrap break-words rounded-md border border-line bg-bg-elev px-3 py-2 text-[11px] text-fg-dim"
            >
              {archive.transcript}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
