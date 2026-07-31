import { useEffect, useRef, useState } from 'react'
import { linkifyFilePaths, extractFilePaths } from '../lib/chatFileLinks'
import { useSessions } from '../state/sessions'
import { type ChatTurn, type ToolUseTrace } from '../state/chat'
import { extractUrls } from '../lib/extractUrls'
import { toast } from '../state/toast'
import { renderChatMarkdown } from '../lib/renderChatMarkdown'
import { handleChatLinkClick, openLinkifiedFilePath } from '../lib/handleChatLinkClick'
import { assistantTurnPresentation } from '../lib/assistantTurnPresentation'

/**
 * Turn rendering — extracted from TerminalChat.tsx (PRD 319+) so it can be
 * shared verbatim by any other view that renders the same chat transcript
 * shape without a SessionTab/PTY behind it (e.g. PromptSessionConversation,
 * PRD 804). Do not fork this file — extend it in place.
 */

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

// Rounded border pill, text-[10px] font-mono — this skill/mcp/tool trace's own tone scheme.
export const TOOL_USE_TONE: Record<ToolUseTrace['kind'], string> = {
  skill: 'border-sage/60 bg-sage/10 text-sage',
  mcp: 'border-accent/60 bg-accent/10 text-accent',
  tool: 'border-line bg-elev text-fg-dim',
}

export const TOOL_USE_ICON: Record<ToolUseTrace['kind'], string> = {
  skill: '🧩',
  mcp: '🔌',
  tool: '⚙',
}

// A run of consecutive identical (kind+label) tool uses collapsed into one chip.
// Keeps the raw step count so the "· N steps" summary stays truthful while the
// chip strip stops ballooning when an agent fires e.g. Bash 20× in a row.
export interface ToolUseRun {
  id: string
  kind: ToolUseTrace['kind']
  label: string
  count: number
}

export function collapseToolUseRuns(items: ToolUseTrace[]): ToolUseRun[] {
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
export function runLabel(run: ToolUseRun): string {
  return run.count > 1 ? `${run.label} ×${run.count}` : run.label
}

export function ToolUseTraceStrip({
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
export const ERROR_TEXT = 'text-[#8a2f28]'
export const ERROR_TINT = 'border-[#b8443c]/40 bg-[#b8443c]/10'
export const AMBER_TEXT = 'text-[#7a5416]'
export const AMBER_TINT = 'border-[#8e641a]/40 bg-[#8e641a]/10'

// Stable substring match against the notice text chatRunner.cjs emits on MCP
// consent-denial (chatRunner.cjs:415-423) — matching our own emitted wording,
// not the CLI's, so it stays correct even if the CLI's phrasing changes.
const CONSENT_NOTICE_MARKER = 'needs interactive consent for an MCP server'

export function Turn({
  turn,
  cwd,
  tabId,
  runActive = false,
  consentActionDisabled = false,
  enableRawSessionActions = true,
}: {
  turn: ChatTurn
  cwd: string
  tabId: string
  runActive?: boolean
  consentActionDisabled?: boolean
  /** False for views with no backing SessionTab/PTY (e.g. PromptSessionConversation,
   *  PRD 804) — hides the "Grant consent" action, which drives a real tab's raw
   *  xterm session via useSessions and has no equivalent there. */
  enableRawSessionActions?: boolean
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
        {isConsentNotice && enableRawSessionActions && (
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
