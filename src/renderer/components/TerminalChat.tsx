import { useEffect, useRef, useState } from 'react'
import { linkifyFilePaths, extractFilePaths } from '../lib/chatFileLinks'
import { useSessions } from '../state/sessions'
import { useChat, isChainResolved, type ChatTurn, type PromptTicket, type ToolUseTrace } from '../state/chat'
import { useScheduleState } from '../state/scheduleState'
import { RAW_MODELS, type RawModel } from '../lib/rawSessionModel'
import { LearningPanel } from './LearningPanel'
import { extractUrls } from '../lib/extractUrls'
import { decideSubmitAction } from '../lib/slashCommand'
import { toast } from '../state/toast'
import { resolveChatPaste } from '../lib/pasteImageIntoChat'
import { renderChatMarkdown } from '../lib/renderChatMarkdown'
import { handleChatLinkClick, openLinkifiedFilePath } from '../lib/handleChatLinkClick'
import { assistantTurnPresentation } from '../lib/assistantTurnPresentation'
import { mergeTicketsForDisplay, ticketDisplayStatus, ticketTagTone } from '../lib/ticketDisplay'
import { setPendingPrdSlug } from '../lib/prdDeepLink'
import { PrdStatusPill } from './tabs/scheduler/sched-primitives'
import { TicketDetailView } from './TicketDetailView'
import { PasteThumbnail } from './PasteThumbnail'
import { EmptyState } from './ui/EmptyState'
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

// Raw-markdown heuristic for "does this turn contain a list" — used only to add a
// CSS class to the container; not a real markdown AST parse (see renderChatMarkdown).
const HAS_LIST_RE = /^\s*(?:[-*+]\s+.+|\d+\.\s+.+)/m
function hasMarkdownList(text: string): boolean {
  return HAS_LIST_RE.test(text)
}

// Electron's permission handler (index.cjs) only grants media/audioCapture/
// microphone, so navigator.clipboard.writeText() always rejects here — write
// through the main-process IPC path instead (already used correctly by the
// Recorder-export Copy-to-clipboard feature, PRD 412).
function copyToClipboard(text: string, onDone: (ok: boolean) => void): void {
  window.api.clipboard
    .writeText(text)
    .then((r) => onDone(!!r?.ok))
    .catch(() => onDone(false))
}

function UrlCallout({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    copyToClipboard(url, (ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1100)
      } else {
        toast.error('Copy failed')
      }
    })
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

// Same callout shape as UrlCallout, for bare file-path mentions (e.g. a pasted
// clipboard image path) — the label opens the file (reusing the same
// resolve/validate/open path as inline chat-file-link clicks) instead of
// external-opening a URL.
function FileCallout({ path, cwd }: { path: string; cwd: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    copyToClipboard(path, (ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1100)
      } else {
        toast.error('Copy failed')
      }
    })
  }
  const onOpen = () => { void openLinkifiedFilePath(path, cwd) }
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs">
      <span aria-hidden className="text-fg-dim">
        📄
      </span>
      <button
        onClick={onOpen}
        title="Open in Editor"
        className="min-w-0 flex-1 truncate text-left font-mono text-fg-dim hover:text-fg hover:underline"
      >
        {path}
      </button>
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

// A run of consecutive identical (kind+label) tool uses collapsed into one chip.
// Keeps the raw step count so the "· N steps" summary stays truthful while the
// chip strip stops ballooning when an agent fires e.g. Bash 20× in a row.
interface ToolUseRun {
  id: string
  kind: ToolUseTrace['kind']
  label: string
  count: number
}

function collapseToolUseRuns(items: ToolUseTrace[]): ToolUseRun[] {
  const runs: ToolUseRun[] = []
  for (const u of items) {
    const last = runs[runs.length - 1]
    if (last && last.kind === u.kind && last.label === u.label) {
      last.count += 1
      last.id = u.id // key off the newest member so React reuses the chip node
    } else {
      runs.push({ id: u.id, kind: u.kind, label: u.label, count: 1 })
    }
  }
  return runs
}

// "Bash" · "Bash ×2" · "Bash ×12" — compact, and only when it actually repeated.
function runLabel(run: ToolUseRun): string {
  return run.count > 1 ? `${run.label} ×${run.count}` : run.label
}

function ToolUseTraceStrip({
  items,
  running = false,
}: {
  items: ToolUseTrace[] | undefined
  running?: boolean
}) {
  if (!items?.length) return null
  const runs = collapseToolUseRuns(items)
  const lastIdx = runs.length - 1
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1">
      {runs.map((u, i) => {
        const inFlight = running && i === lastIdx
        return (
          <span
            key={u.id}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono font-medium ${
              inFlight ? 'border-accent/40 bg-accent/10 text-accent' : TOOL_USE_TONE[u.kind]
            }`}
          >
            {TOOL_USE_ICON[u.kind]} {runLabel(u)}
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
  browser: 'Browser',
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
  scheduler: 'Scheduler',
  editor: 'Editor',
  voice: 'Voice',
  repoviz: 'Repo Viz',
  search: 'Search',
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
  const runs = collapseToolUseRuns(liveToolUses)
  const inFlightIdx = running && !stream ? runs.length - 1 : -1
  return (
    <div className="min-h-0 max-h-[45%] shrink-0 overflow-y-auto border-b border-rule px-3 py-4">
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
      {runs.length === 0 ? (
        <div className="mt-1.5 text-[11px] text-fg-faint">No tool activity yet.</div>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {runs.map((u, i) => (
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
              <span className="truncate">{runLabel(u)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Navigates to Scheduler and selects a PRD there, reusing AlmanacFooter's
// pill-click plumbing (dispatch a CustomEvent, App.tsx's window listener
// routes it) rather than inventing a new cross-tab routing mechanism.
// 'sm:navigate' already switches tabs (also used by the slash-nav shortcut
// below); the slug itself goes through prdDeepLink.ts (not a second bare
// CustomEvent) since SchedulerPrdsView may not be mounted yet to receive it.
export function openPrdSlug(slug: string): void {
  setPendingPrdSlug(slug)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'scheduler' }))
}

// Small Feature/Bug chip for a ticket row — reuses ticketTagTone's
// STATUS_TONE-shaped tone object (ticketDisplay.ts) rather than a new color system.
export function TagChip({ tag }: { tag: 'feature' | 'bug' }) {
  const tone = ticketTagTone(tag)
  return (
    <span
      className={`inline-block text-[10.5px] font-semibold px-[7px] py-0.5 rounded-full ${tone.bg} ${tone.text}${tone.border ? ' ring-1 ring-inset ring-line' : ''}`}
    >
      {tone.label}
    </span>
  )
}

// Side panel showing a tab's PromptTicket queue (PRD 750): the in-flight
// ticket plus anything queued behind it, and — folded into the same list —
// recently finished tickets (done/failed/dispatched-to-prd) so a ticket
// doesn't vanish from view the instant it leaves the "queued/running" state.
export function QueueTicketPanel({
  tickets,
  onSelectNeedsInput,
  onSelectTicket,
}: {
  tickets: PromptTicket[]
  /** Fired when a 'needs-input' ticket is clicked — scrolls/highlights its question turn and focuses the composer. */
  onSelectNeedsInput?: (ticket: PromptTicket) => void
  /** Fired when any other ticket row is clicked — opens the Detailed view (PRD 777). */
  onSelectTicket?: (ticket: PromptTicket) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Unlike the main transcript panel's unconditional auto-scroll (line ~562),
  // this panel guards on "was the user already at the bottom" — root cause of
  // the reported jump: with no scroll anchoring at all, a mid-turn ticket
  // arrival (queued -> active) or a ticket growing (dispatched-to-prd's
  // prdSlugs row appearing) left scrollTop fixed while scrollHeight grew
  // underneath it, so the visible window silently cut off/reflowed instead of
  // staying pinned to the newest item. Defaults true so the panel starts
  // pinned to the bottom before any scroll event has fired.
  const stickToBottomRef = useRef(true)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
  }

  // Keyed on a content fingerprint, not the `tickets` array itself —
  // mergeTicketsForDisplay (ticketDisplay.ts) builds a fresh array on every
  // TerminalChat render (every streamed token, every keystroke), which would
  // otherwise re-fire this effect on unrelated re-renders during a hot
  // streaming path. Mirrors the primitive-dependency style already used by
  // the sibling transcript-panel auto-scroll effect (turns.length/stream).
  const ticketsFingerprint = tickets.map((t) => `${t.id}:${t.status}`).join(',')
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [ticketsFingerprint])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
      data-testid="chat-queue-panel"
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
        Prompt queue
      </div>
      {tickets.length === 0 ? (
        <EmptyState title="No prompts queued" hint="Prompts sent while a turn is running will show up here." />
      ) : (
        <ul className="space-y-2">
          {tickets.map((t) => {
            const isNeedsInput = t.status === 'needs-input'
            const clickable = isNeedsInput || !!onSelectTicket
            return (
            <li
              key={t.id}
              className={`rounded-lg border px-2.5 py-2 ${
                isNeedsInput
                  ? 'cursor-pointer border-[#8e641a]/40 bg-[#8e641a]/10 hover:bg-[#8e641a]/20'
                  : clickable
                    ? 'cursor-pointer border-line bg-elev hover:bg-hi'
                    : 'border-line bg-elev'
              }`}
              data-testid="chat-queue-ticket"
              onClick={clickable ? () => (isNeedsInput ? onSelectNeedsInput?.(t) : onSelectTicket?.(t)) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
            >
              <PrdStatusPill status={ticketDisplayStatus(t.status)} />
              {t.tag && <span className="ml-1.5"><TagChip tag={t.tag} /></span>}
              <div className="mt-1.5 truncate text-xs text-fg-dim" title={t.text}>
                {t.text}
              </div>
              {t.status === 'dispatched-to-prd' && !!t.prdSlugs?.length && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {t.prdSlugs.map((slug) => (
                    <button
                      key={slug}
                      onClick={() => openPrdSlug(slug)}
                      title={`Open PRD "${slug}" in Scheduler`}
                      className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-accent hover:bg-hi"
                    >
                      #{slug}
                    </button>
                  ))}
                </div>
              )}
            </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// Stable substring match against the notice text chatRunner.cjs emits on MCP
// consent-denial (chatRunner.cjs:415-423) — matching our own emitted wording,
// not the CLI's, so it stays correct even if the CLI's phrasing changes.
const CONSENT_NOTICE_MARKER = 'needs interactive consent for an MCP server'

function Turn({
  turn,
  cwd,
  tabId,
  runActive = false,
  consentActionDisabled = false,
}: {
  turn: ChatTurn
  cwd: string
  tabId: string
  runActive?: boolean
  consentActionDisabled?: boolean
}) {
  // Declared unconditionally (rules of hooks) even though only the assistant
  // 'text' branch below uses them — the early returns for other turn roles
  // happen after these hooks run.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const presentation = turn.role === 'assistant' ? assistantTurnPresentation(turn, runActive) : null
  useEffect(() => {
    if (turn.role === 'assistant' && presentation === 'text' && bodyRef.current) {
      linkifyFilePaths(bodyRef.current)
    }
  }, [turn.role, presentation, turn.text])

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
        <ToolUseTraceStrip items={turn.toolUses} />
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
  if (turn.role === 'notice') {
    const isConsentNotice = turn.text.includes(CONSENT_NOTICE_MARKER)
    const onGrantConsent = () => {
      // Queue the command for Terminal.tsx's spawn handler to auto-type once
      // the PTY is ready, then wake the tab into that live raw session — same
      // mechanism as the existing "Open raw session" button, just pre-filled
      // so the user lands directly at the confirmation prompt instead of an
      // empty terminal. The confirmation itself is never auto-answered.
      useSessions.getState().queueRawCommand(tabId, '/design consent')
      void useSessions.getState().wakeTab(tabId)
    }
    return (
      <div className={`rounded-[14px] border px-4 py-3 text-sm ${AMBER_TINT} ${AMBER_TEXT}`}>
        <div className={`mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${AMBER_TEXT}`}>
          <span aria-hidden>ℹ️</span>
          Needs your attention
        </div>
        {turn.text}
        {isConsentNotice && (
          <div className={`mt-2 border-t pt-2 ${AMBER_TINT}`}>
            <button
              onClick={onGrantConsent}
              disabled={consentActionDisabled}
              title={consentActionDisabled ? 'Cancel or wait for the current run before opening a raw session' : 'Open a live interactive claude session with /design consent pre-typed'}
              className={`rounded border px-2 py-1 text-xs font-medium hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent ${AMBER_TEXT} border-current`}
            >
              Grant consent →
            </button>
          </div>
        )}
      </div>
    )
  }
  // assistant — render the run's final message verbatim (markdown), guarded
  // against empty text (e.g. a resumed turn that opens with a non-rendered
  // thinking block before any visible text arrives — see
  // session-manager-operations/feedback/2026-07-21-chat-empty-assistant-bubble.md).
  if (presentation === 'suppress') return null

  const urls = extractUrls(turn.text)
  const filePaths = extractFilePaths(turn.text)
  const isPlan = hasMarkdownList(turn.text)
  return (
    <div className="flex max-w-[90%] items-start gap-2">
      <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-line bg-elev text-xs font-semibold text-accent">
        C
      </div>
      <div className="min-w-0 flex-1">
        <ToolUseTraceStrip items={turn.toolUses} running={presentation === 'working'} />
        {presentation === 'working' ? (
          <div className="rounded-lg bg-elev px-3 py-2 text-sm text-fg-dim">
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              working…
            </span>
          </div>
        ) : presentation === 'placeholder' ? (
          <div className="rounded-lg bg-elev px-3 py-2 text-sm italic text-fg-dim">
            (no textual reply — see tool activity above)
          </div>
        ) : (
          <>
            <div
              ref={bodyRef}
              className={`prose-chat rounded-lg bg-elev px-3 py-2 text-sm leading-relaxed text-fg ${isPlan ? 'prose-chat--plan' : ''}`}
              onClick={(e) => { void handleChatLinkClick(e, cwd) }}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: renderChatMarkdown(turn.text) }}
            />
            {urls.map((url) => (
              <UrlCallout key={url} url={url} />
            ))}
            {filePaths.map((path) => (
              <FileCallout key={path} path={path} cwd={cwd} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export function TerminalChat({ tabId, cwd }: Props) {
  const tab = useSessions((s) => s.tabs.find((t) => t.id === tabId))
  const sessionId = tab?.sessionId ?? tabId
  const chat = useChat((s) => s.chats[tabId])
  const send = useChat((s) => s.send)
  const hydrate = useChat((s) => s.hydrate)
  const resetThread = useChat((s) => s.resetThread)
  const pushNotice = useChat((s) => s.pushNotice)
  const [draft, setDraft] = useState('')
  const [composerTag, setComposerTag] = useState<'feature' | 'bug'>('feature')
  // 'new' or the id of an open chain's ROOT ticket to continue (PRD 775).
  const [chainChoice, setChainChoice] = useState<string>('new')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [pastedImage, setPastedImage] = useState<string | null>(null)
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null)
  // id of the ticket whose Detailed view (PRD 777) is open, or null for the
  // flat list. The list panel stays mounted (hidden via CSS, not unmounted)
  // while a detail view is open so its scroll position survives the round trip.
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  // Which pane is visible at ≤RAIL_BREAKPOINT, where only one of the two fits
  // (PRD 776). Defaults to 'queue' — the Prompt Queue is now the primary
  // working surface, inverting the old narrow-viewport default of the
  // transcript. Irrelevant above the breakpoint, where both panes show at once.
  const [narrowPane, setNarrowPane] = useState<'queue' | 'transcript'>('queue')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const viewportWidth = useViewportWidth()
  const showRail = viewportWidth > RAIL_BREAKPOINT
  const queueVisible = showRail || narrowPane === 'queue'
  const transcriptVisible = showRail || narrowPane === 'transcript'

  const turns = chat?.turns ?? []
  const running = chat?.running ?? false
  const stream = chat?.stream ?? ''
  const queuedPosition = chat?.queuedPosition ?? 0
  const liveToolUses = chat?.liveToolUses ?? []
  const displayTickets = mergeTicketsForDisplay(
    chat?.ticketHistory ?? [],
    chat?.activeTicket,
    chat?.queue ?? [],
  )
  const needsInputTicket = displayTickets.find((t) => t.status === 'needs-input') ?? null

  // Open, unresolved dispatched-to-prd chains for this tab (PRD 775) — only
  // ROOT tickets (chainRootId unset) are offered as continuation targets;
  // a follow-up ticket's own chain always resolves back to its root. Read
  // job status from scheduleState.ts (the existing store), never a second
  // polling mechanism.
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs ?? [])
  const openChains = (chat?.ticketHistory ?? []).filter(
    (t) => t.status === 'dispatched-to-prd' && !t.chainRootId && !isChainResolved(t, scheduleJobs),
  )
  const openChainsFingerprint = openChains.map((t) => t.id).join(',')
  useEffect(() => {
    if (chainChoice !== 'new' && !openChains.some((t) => t.id === chainChoice)) {
      setChainChoice('new')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChainsFingerprint, chainChoice])

  // Clicking a needs-input ticket in the panel scrolls to + briefly highlights
  // its question turn, and focuses the composer so the reply is obvious. At
  // narrow viewport the transcript pane may not be mounted (Prompt Queue is
  // primary there) — flip to it first and defer the scroll/highlight to the
  // next frame so the target turn exists in the DOM.
  const scrollToQuestion = (ticket: PromptTicket) => {
    const turnId = ticket.questionTurnId
    const focusAndScroll = () => {
      if (turnId) {
        const el = document.getElementById(`chat-turn-${turnId}`)
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
        setHighlightedTurnId(turnId)
        window.setTimeout(() => {
          setHighlightedTurnId((cur) => (cur === turnId ? null : cur))
        }, 1500)
      }
      textareaRef.current?.focus()
    }
    if (!showRail) {
      setNarrowPane('transcript')
      requestAnimationFrame(focusAndScroll)
    } else {
      focusAndScroll()
    }
  }

  // One-shot history rehydration from the durable exchanges store.
  useEffect(() => {
    void hydrate({ tabId, cwd, sessionId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // Auto-scroll to the newest turn / streamed output. Re-runs when the
  // transcript pane becomes visible (narrow-viewport toggle) so switching
  // into it lands at the bottom instead of wherever the browser defaulted.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns.length, stream, running, transcriptVisible])

  const submit = () => {
    // Sending while `running` is allowed — send() (chat.ts:189-209) routes it
    // through the FIFO queue instead of firing a second concurrent
    // chatRunner.run() for this tab, so no extra guarding is needed here.
    if (!draft.trim()) return
    const action = decideSubmitAction(draft.trim())
    if (action.type === 'nav') {
      setDraft('')
      window.dispatchEvent(new CustomEvent('sm:navigate', { detail: action.key }))
      const message = `→ opened ${NAV_LABELS[action.key]} — showing the live list`
      pushNotice(tabId, message)
      toast.info(`Opened ${NAV_LABELS[action.key]} — showing the live list`)
      return
    }
    if (action.type === 'warn-unrouted') {
      toast.info(
        'Interactive prompts (consent/approval dialogs) need a real terminal — ' +
          'use "Open raw session" if this command asks you something and nothing appears.',
      )
    }
    const chainRootId = chainChoice !== 'new' ? chainChoice : undefined
    send({ tabId, sessionId, cwd, prompt: draft, tag: composerTag, chainRootId })
    setDraft('')
    setPastedImage(null)
    setChainChoice('new')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const selStart = el.selectionStart ?? draft.length
    const selEnd = el.selectionEnd ?? selStart
    // We handle image-first-then-text ourselves, so block the browser default.
    e.preventDefault()
    void (async () => {
      try {
        const r = await resolveChatPaste(
          {
            pasteImage: () => window.api.clipboard.pasteImage(),
            readText: () => window.api.clipboard.pasteText().then((r) => (r.ok ? r.text : '')),
          },
          draft,
          selStart,
          selEnd,
        )
        setDraft(r.value)
        if (r.toast) toast.info(r.toast)
        if (r.imagePath) setPastedImage(r.imagePath)
        // Restore caret after React re-renders the controlled value.
        requestAnimationFrame(() => {
          try {
            el.setSelectionRange(r.caret, r.caret)
          } catch {
            /* detached */
          }
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Paste failed — clipboard unavailable')
      }
    })()
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

  const [confirmingNewThread, setConfirmingNewThread] = useState(false)

  const newThread = () => {
    if (running) return
    if (!confirmingNewThread) {
      setConfirmingNewThread(true)
      return
    }
    useSessions.getState().newSession(tabId)
    resetThread(tabId)
    setConfirmingNewThread(false)
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
        <div className="flex items-stretch gap-2">
        <button
          onClick={newThread}
          onBlur={() => setConfirmingNewThread(false)}
          disabled={running}
          title="Start a brand-new session (clears this conversation's context; shared by both Chat and Raw)"
          className={`rounded border px-2 py-1 text-xs hover:bg-elev disabled:opacity-40 disabled:hover:bg-transparent ${
            confirmingNewThread ? 'border-accent/60 text-accent' : 'border-line text-fg-dim hover:text-fg'
          }`}
        >
          {confirmingNewThread ? 'Confirm new session?' : 'New session'}
        </button>
        <div ref={modelMenuRef} className="relative flex items-stretch">
          <button
            onClick={openRaw}
            disabled={running}
            className="rounded-l border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
            title={running ? 'Cancel or wait for the current run before opening a raw session' : 'Drop into a live interactive claude session in this directory'}
          >
            Open raw session ⌃
          </button>
          <button
            onClick={() => setModelMenuOpen((v) => !v)}
            disabled={running}
            className="rounded-r border border-l-0 border-line px-1.5 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
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
      </div>

      <div className="flex min-h-0 flex-1">
        {queueVisible && (
          <div className="flex min-w-0 flex-1 flex-col">
            {!showRail && (
              <div className="flex items-center justify-end border-b border-rule px-3 py-1.5">
                <button
                  onClick={() => setNarrowPane('transcript')}
                  data-testid="show-transcript-btn"
                  className="rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg"
                >
                  View transcript →
                </button>
              </div>
            )}
            <div className={selectedTicketId ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
              <QueueTicketPanel
                tickets={displayTickets}
                onSelectNeedsInput={scrollToQuestion}
                onSelectTicket={(t) => setSelectedTicketId(t.id)}
              />
            </div>
            {selectedTicketId &&
              (() => {
                const selectedTicket = displayTickets.find((t) => t.id === selectedTicketId)
                if (!selectedTicket) return null
                return (
                  <TicketDetailView
                    ticket={selectedTicket}
                    allTickets={displayTickets}
                    jobs={scheduleJobs}
                    onClose={() => setSelectedTicketId(null)}
                  />
                )
              })()}
          </div>
        )}
        {transcriptVisible && (
          <div
            className={
              showRail
                ? 'flex h-full w-[280px] shrink-0 flex-col border-l border-rule'
                : 'flex min-w-0 flex-1 flex-col'
            }
          >
            {!showRail && (
              <div className="flex items-center justify-start border-b border-rule px-3 py-1.5">
                <button
                  onClick={() => setNarrowPane('queue')}
                  data-testid="show-queue-btn"
                  className="rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg"
                >
                  ← Back to queue
                </button>
              </div>
            )}
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
            <div
              ref={scrollRef}
              className={
                showRail
                  ? 'min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4'
                  : 'min-w-0 flex-1 space-y-3 overflow-y-auto px-4 py-4'
              }
            >
              {turns.length === 0 && !running && (
                <div className="flex h-full items-center justify-center text-sm text-fg-faint select-none">
                  Type a command to start a session. It runs, reports back, and asks if it needs you.
                </div>
              )}
              {turns.map((t, i) => (
                <div
                  key={t.id}
                  id={`chat-turn-${t.id}`}
                  className={
                    highlightedTurnId === t.id
                      ? 'rounded-[14px] ring-2 ring-accent/60 transition-shadow'
                      : 'rounded-[14px]'
                  }
                >
                  <Turn
                    turn={t}
                    cwd={cwd}
                    tabId={tabId}
                    runActive={running && t.role === 'assistant' && i === turns.length - 1}
                    consentActionDisabled={running}
                  />
                </div>
              ))}
              {running && (
                <div className="max-w-[90%]">
                  <ToolUseTraceStrip items={liveToolUses} running={running && !stream} />
                  <div className="rounded-lg bg-elev px-3 py-2 text-sm text-fg-dim">
                    {queuedPosition > 0 ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-butter" />
                        queued · #{queuedPosition} — waiting for a free run slot
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
          </div>
        )}
      </div>

      <div className="border-t border-rule p-3">
        {pastedImage && (
          <PasteThumbnail key={pastedImage} path={pastedImage} onDismiss={() => setPastedImage(null)} />
        )}
        {openChains.length > 0 && (
          <div
            className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-dim"
            role="radiogroup"
            aria-label="New item or continue an existing PRD chain"
            data-testid="chain-picker"
          >
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="chain-choice"
                checked={chainChoice === 'new'}
                onChange={() => setChainChoice('new')}
              />
              New item
            </label>
            {openChains.map((t) => (
              <label key={t.id} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="chain-choice"
                  checked={chainChoice === t.id}
                  onChange={() => setChainChoice(t.id)}
                />
                Continue: {t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text}
              </label>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={2}
            placeholder={
              needsInputTicket
                ? 'Reply to answer the pending question…'
                : running
                  ? 'Running… send to queue a follow-up prompt'
                  : 'Type a command (Enter to send, Shift+Enter for newline)'
            }
            className="flex-1 resize-none rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5" role="group" aria-label="Feature or bug tag">
            <button
              type="button"
              onClick={() => setComposerTag('feature')}
              aria-pressed={composerTag === 'feature'}
              className={`rounded px-2 py-1.5 text-xs font-medium ${
                composerTag === 'feature' ? 'bg-sage/25 text-sage' : 'text-fg-faint hover:text-fg-dim'
              }`}
            >
              Feature
            </button>
            <button
              type="button"
              onClick={() => setComposerTag('bug')}
              aria-pressed={composerTag === 'bug'}
              className={`rounded px-2 py-1.5 text-xs font-medium ${
                composerTag === 'bug' ? 'bg-accent/15 text-accent' : 'text-fg-faint hover:text-fg-dim'
              }`}
            >
              Bug
            </button>
          </div>
          {running && (
            <button
              onClick={() => window.api.chat.cancel(tabId)}
              className={`rounded-md border px-3 py-2 text-sm hover:bg-[#b8443c]/10 ${ERROR_TEXT} border-[#b8443c]/40`}
            >
              Cancel
            </button>
          )}
          <button
            onClick={submit}
            disabled={!draft.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
