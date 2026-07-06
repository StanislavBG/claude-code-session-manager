import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useSessions } from '../state/sessions'
import { useChat, type ChatTurn, type ToolUseTrace } from '../state/chat'
import { RAW_MODELS, type RawModel } from '../lib/rawSessionModel'
import { LearningPanel } from './LearningPanel'

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

// Mirrors hive-primitives.tsx's ToolChip shape (rounded border pill, text-[10px]
// font-mono) without importing it directly — that component's tone is a binary
// read/write concept tied to the Hive design system, not this skill/mcp/tool trace.
const TOOL_USE_TONE: Record<ToolUseTrace['kind'], string> = {
  skill: 'border-sage/60 bg-sage/10 text-sage',
  mcp: 'border-accent/60 bg-accent/10 text-accent',
  tool: 'border-line bg-elev text-fg-dim',
}

const TOOL_USE_ICON: Record<ToolUseTrace['kind'], string> = {
  skill: '🧩',
  mcp: '🔌',
  tool: '⚙',
}

function ToolUseTraceStrip({
  items,
  running = false,
}: {
  items: ToolUseTrace[] | undefined
  running?: boolean
}) {
  if (!items?.length) return null
  const lastIdx = items.length - 1
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1">
      {items.map((u, i) => {
        const inFlight = running && i === lastIdx
        return (
          <span
            key={u.id}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono font-medium ${
              inFlight ? 'border-accent/40 bg-accent/10 text-accent' : TOOL_USE_TONE[u.kind]
            }`}
          >
            {TOOL_USE_ICON[u.kind]} {u.label}
          </span>
        )
      })}
      <span className="text-[10px] font-mono text-fg-dim">· {items.length} steps</span>
    </div>
  )
}

// Error/question turns keep red/amber as an intentional accent (same pattern as
// Toast.tsx / StatusBadge.tsx) but retuned off the dark-theme red-*/amber-* shades:
// text colors below are checked at >=4.5:1 contrast against all three paper
// background shades (#f6efe1 / #efe6d3 / #fbf6ec) using the same WCAG formula as
// the TerminalControls.tsx xterm-theme fix.
const ERROR_TEXT = 'text-[#8a2f28]'
const ERROR_TINT = 'border-[#b8443c]/40 bg-[#b8443c]/10'
const AMBER_TEXT = 'text-[#7a5416]'
const AMBER_TINT = 'border-[#8e641a]/40 bg-[#8e641a]/10'

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-tl-lg rounded-tr-lg rounded-bl-lg rounded-br-sm bg-accent/15 px-3 py-2 text-sm text-fg whitespace-pre-wrap">
          {turn.text}
        </div>
      </div>
    )
  }
  if (turn.role === 'error') {
    return (
      <div className={`rounded-lg border px-3 py-2 text-sm ${ERROR_TINT} ${ERROR_TEXT}`}>
        {turn.text}
      </div>
    )
  }
  if (turn.role === 'question') {
    return (
      <div className={`rounded-lg border px-3 py-2 text-sm ${AMBER_TINT} ${AMBER_TEXT}`}>
        <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${AMBER_TEXT}`}>
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
    <div className="flex max-w-[90%] items-start gap-2">
      <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-line bg-elev text-xs font-semibold text-accent">
        C
      </div>
      <div className="min-w-0 flex-1">
        <ToolUseTraceStrip items={turn.toolUses} />
        <div
          className="prose-chat rounded-lg bg-elev px-3 py-2 text-sm leading-relaxed text-fg [&_p]:max-w-lg [&_pre]:max-w-none"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderMd(turn.text) }}
        />
      </div>
    </div>
  )
}

export function TerminalChat({ tabId, cwd }: Props) {
  const sessionId = useSessions((s) => s.tabs.find((t) => t.id === tabId)?.claudeSessionId ?? tabId)
  const chat = useChat((s) => s.chats[tabId])
  const send = useChat((s) => s.send)
  const hydrate = useChat((s) => s.hydrate)
  const [draft, setDraft] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)

  const turns = chat?.turns ?? []
  const running = chat?.running ?? false
  const stream = chat?.stream ?? ''
  const queuedPosition = chat?.queuedPosition ?? 0
  const liveToolUses = chat?.liveToolUses ?? []

  // One-shot history rehydration from the durable exchanges store.
  useEffect(() => {
    void hydrate({ tabId, cwd, sessionId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

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

  // Close the model menu on outside click so it doesn't linger open over content.
  useEffect(() => {
    if (!modelMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) setModelMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [modelMenuOpen])

  const openRaw = () => {
    void useSessions.getState().wakeTab(tabId)
  }

  const openRawWithModel = (model: RawModel) => {
    void useSessions.getState().wakeTab(tabId, model)
    setModelMenuOpen(false)
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-rule px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="font-serif text-base text-fg">Chat</div>
          <div className="text-xs text-fg-dim">
            Chat · headless session — no process runs between commands
          </div>
          <LearningPanel active="terminal" />
        </div>
        <div ref={modelMenuRef} className="relative flex items-stretch">
          <button
            onClick={openRaw}
            className="rounded-l border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg"
            title="Drop into a live interactive claude session in this directory"
          >
            Open raw session ⌃
          </button>
          <button
            onClick={() => setModelMenuOpen((v) => !v)}
            className="rounded-r border border-l-0 border-line px-1.5 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg"
            title="Choose model for this raw session"
          >
            ▾
          </button>
          {modelMenuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-32 rounded border border-line bg-hi shadow-lg">
              {RAW_MODELS.map((m) => (
                <button
                  key={m}
                  onClick={() => openRawWithModel(m)}
                  className="block w-full px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-elev hover:text-fg"
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {turns.length === 0 && !running && (
          <div className="flex h-full items-center justify-center text-sm text-fg-faint select-none">
            Type a command to start a session. It runs, reports back, and asks if it needs you.
          </div>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} />
        ))}
        {running && (
          <div className="max-w-[90%]">
            <ToolUseTraceStrip items={liveToolUses} running={running && !stream} />
            <div className="rounded-lg bg-elev px-3 py-2 text-sm text-fg-dim">
              {queuedPosition > 0 ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-butter" />
                  queued · #{queuedPosition} (one loop runs at a time)
                </span>
              ) : stream ? (
                <span className="whitespace-pre-wrap">{stream}</span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                  running…
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-rule p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={running}
            rows={2}
            placeholder={running ? 'Running… cancel or wait' : 'Type a command (Enter to send, Shift+Enter for newline)'}
            className="flex-1 resize-none rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none disabled:opacity-50"
          />
          {running ? (
            <button
              onClick={() => window.api.chat.cancel(tabId)}
              className={`rounded-md border px-3 py-2 text-sm hover:bg-[#b8443c]/10 ${ERROR_TEXT} border-[#b8443c]/40`}
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!draft.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
