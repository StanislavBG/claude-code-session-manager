import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useSessions } from '../state/sessions'
import { useChat, type ChatTurn } from '../state/chat'

/**
 * TerminalChat — the DEFAULT terminal-screen experience for a dormant tab
 * (PRD 319). The user types a command; it runs as a headless `claude -p` job
 * via the chat engine (PRD 318), streaming back here. On completion the run's
 * own final assistant message renders verbatim; if the run asks questions
 * (structured stop signal), they render and the next message resumes the same
 * session with the answer. "Open raw session" drops into the live xterm via
 * wakeTab — the raw experience stays available on demand.
 *
 * Plain DOM textarea — NOT xterm. xterm is only for the woken raw session.
 */

interface Props {
  tabId: string
  cwd: string
}

function renderMd(src: string): string {
  // marked.parse is sync for string input; sanitize before injecting.
  return DOMPurify.sanitize(marked.parse(src, { async: false }) as string)
}

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-accent/15 px-3 py-2 text-sm text-fg whitespace-pre-wrap">
          {turn.text}
        </div>
      </div>
    )
  }
  if (turn.role === 'error') {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        {turn.text}
      </div>
    )
  }
  if (turn.role === 'question') {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
          Needs your answer
        </div>
        <ul className="list-disc space-y-1 pl-5">
          {(turn.questions ?? [turn.text]).map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      </div>
    )
  }
  // assistant — render the run's final message verbatim (markdown).
  return (
    <div
      className="prose-chat max-w-[90%] rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-fg"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: renderMd(turn.text) }}
    />
  )
}

export function TerminalChat({ tabId, cwd }: Props) {
  const sessionId = useSessions((s) => s.tabs.find((t) => t.id === tabId)?.claudeSessionId ?? tabId)
  const chat = useChat((s) => s.chats[tabId])
  const send = useChat((s) => s.send)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const turns = chat?.turns ?? []
  const running = chat?.running ?? false
  const stream = chat?.stream ?? ''

  // Auto-scroll to the newest turn / streamed output.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns.length, stream, running])

  const submit = () => {
    if (running || !draft.trim()) return
    send({ tabId, sessionId, cwd, prompt: draft })
    setDraft('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const openRaw = () => {
    void useSessions.getState().wakeTab(tabId)
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-2">
        <div className="text-xs text-fg-muted">
          Chat · headless session — no process runs between commands
        </div>
        <button
          onClick={openRaw}
          className="rounded border border-white/10 px-2 py-1 text-xs text-fg-muted hover:bg-white/5 hover:text-fg"
          title="Drop into a live interactive claude session in this directory"
        >
          Open raw session ⌃
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {turns.length === 0 && !running && (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted select-none">
            Type a command to start a session. It runs, reports back, and asks if it needs you.
          </div>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} />
        ))}
        {running && (
          <div className="max-w-[90%] rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-fg-muted">
            {stream ? (
              <span className="whitespace-pre-wrap">{stream}</span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                running…
              </span>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-white/5 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={running}
            rows={2}
            placeholder={running ? 'Running… cancel or wait' : 'Type a command (Enter to send, Shift+Enter for newline)'}
            className="flex-1 resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-fg placeholder:text-fg-muted/60 focus:border-accent/50 focus:outline-none disabled:opacity-50"
          />
          {running ? (
            <button
              onClick={() => window.api.chat.cancel(tabId)}
              className="rounded-md border border-red-500/40 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!draft.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent/90 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
