import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useSessions } from '../state/sessions'
import { useChat, type ChatTurn, type ToolUseTrace } from '../state/chat'
import { RAW_MODELS, type RawModel } from '../lib/rawSessionModel'
import { LearningPanel } from './LearningPanel'
import { extractUrls } from '../lib/extractUrls'
import { matchSlashNav } from '../lib/slashCommand'
import { toast } from '../state/toast'
import type { NavKey } from './LeftNav'

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

// Raw-markdown heuristic for "does this turn contain a list" — used only to add a
// CSS class to the container; not a real markdown AST parse (see renderMd).
const HAS_LIST_RE = /^\s*(?:[-*+]\s+.+|\d+\.\s+.+)/m
function hasMarkdownList(text: string): boolean {
  return HAS_LIST_RE.test(text)
}

function UrlCallout({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1100)
  }
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs">
      <span aria-hidden className="text-fg-dim">
        🔗
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-fg-dim">{url}</span>
      <button
        onClick={onCopy}
        className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-fg-dim hover:bg-hi hover:text-fg"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
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

// Mirrors the "Chat" design's SessionRail breakpoint (showRail = vw > 1180) —
// narrow enough that a fixed-width rail never fights the message column below it.
const RAIL_BREAKPOINT = 1180

const NAV_LABELS: Record<NavKey, string> = {
  overview: 'Overview',
  terminal: 'Terminal',
  'system-prompt': 'System Prompt',
  settings: 'Settings',
  permissions: 'Permissions',
  skills: 'Skills',
  plugins: 'Plugins',
  mcp: 'MCP Servers',
  hooks: 'Hooks',
  subagents: 'Subagents',
  memory: 'Memory',
  projects: 'Projects',
  history: 'History',
  keybindings: 'Keybindings',
  usage: 'Usage',
  'doc-editor': 'Doc Editor',
  scheduler: 'Scheduler',
  editor: 'Editor',
  voice: 'Voice',
  repoviz: 'Repo Viz',
  search: 'Search',
  prompts: 'Prompts',
  remote: 'Remote',
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

// Read-only, real-data-only subset of the design's SessionRail: no Branch/Model
// (no per-session plumbing reaches this component), no 5h window (that's
// AppStatusBar's job), no Touched files (not captured by classifyToolUse today).
function ChatSessionRail({
  cwd,
  label,
  running,
  queuedPosition,
  stream,
  liveToolUses,
}: {
  cwd: string
  label: string
  running: boolean
  queuedPosition: number
  stream: string
  liveToolUses: ToolUseTrace[]
}) {
  const inFlightIdx = running && !stream ? liveToolUses.length - 1 : -1
  return (
    <div className="w-[280px] shrink-0 overflow-y-auto border-l border-rule px-3 py-4">
      <div className="rounded-lg border border-line bg-elev px-3 py-2.5">
        <div className="text-xs font-semibold text-fg">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-dim" title={cwd}>
          {cwd}
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-dim">
          {running ? (
            queuedPosition > 0 ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-butter" />
                queued · #{queuedPosition}
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                running
              </>
            )
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-line" />
              idle
            </>
          )}
        </div>
      </div>

      <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
        This turn
      </div>
      {liveToolUses.length === 0 ? (
        <div className="mt-1.5 text-[11px] text-fg-faint">No tool activity yet.</div>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {liveToolUses.map((u, i) => (
            <li
              key={u.id}
              className={`flex items-center gap-1.5 rounded border px-1.5 py-1 text-[11px] font-mono ${
                i === inFlightIdx ? 'border-accent/40 bg-accent/10 text-accent' : TOOL_USE_TONE[u.kind]
              }`}
            >
              {i === inFlightIdx ? (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              ) : (
                <span aria-hidden className="shrink-0">
                  {TOOL_USE_ICON[u.kind]}
                </span>
              )}
              <span className="truncate">{u.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

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
      <div className={`rounded-[14px] border px-4 py-3 text-sm ${AMBER_TINT} ${AMBER_TEXT}`}>
        <div className={`mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${AMBER_TEXT}`}>
          <span aria-hidden>❓</span>
          Needs your answer
        </div>
        <ul className="list-disc space-y-1 pl-5">
          {(turn.questions ?? [turn.text]).map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
        <div className={`mt-2 border-t pt-2 text-[11px] opacity-70 ${AMBER_TINT}`}>
          Reply in the composer below to answer.
        </div>
      </div>
    )
  }
  // assistant — render the run's final message verbatim (markdown).
  const urls = extractUrls(turn.text)
  const isPlan = hasMarkdownList(turn.text)
  return (
    <div className="flex max-w-[90%] items-start gap-2">
      <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-line bg-elev text-xs font-semibold text-accent">
        C
      </div>
      <div className="min-w-0 flex-1">
        <ToolUseTraceStrip items={turn.toolUses} />
        <div
          className={`prose-chat rounded-lg bg-elev px-3 py-2 text-sm leading-relaxed text-fg [&_p]:max-w-lg [&_pre]:max-w-none ${isPlan ? 'prose-chat--plan' : ''}`}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderMd(turn.text) }}
        />
        {urls.map((url) => (
          <UrlCallout key={url} url={url} />
        ))}
      </div>
    </div>
  )
}

export function TerminalChat({ tabId, cwd }: Props) {
  const tab = useSessions((s) => s.tabs.find((t) => t.id === tabId))
  const sessionId = tab?.claudeSessionId ?? tabId
  const chat = useChat((s) => s.chats[tabId])
  const send = useChat((s) => s.send)
  const hydrate = useChat((s) => s.hydrate)
  const [draft, setDraft] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const viewportWidth = useViewportWidth()
  const showRail = viewportWidth > RAIL_BREAKPOINT

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
    const navKey = matchSlashNav(draft.trim())
    if (navKey) {
      setDraft('')
      window.dispatchEvent(new CustomEvent('sm:navigate', { detail: navKey }))
      toast.info(`Opened ${NAV_LABELS[navKey]} — showing the live list`)
      return
    }
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

      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-w-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
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
        {showRail && (
          <ChatSessionRail
            cwd={cwd}
            label={tab?.label ?? cwd}
            running={running}
            queuedPosition={queuedPosition}
            stream={stream}
            liveToolUses={liveToolUses}
          />
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
