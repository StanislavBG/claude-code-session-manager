import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { linkifyFilePaths, extractFilePaths } from '../lib/chatFileLinks'
import { useChat, type ChatTurn, type ToolUseTrace } from '../state/chat'
import { fullSignalText, fullSignalNames, isToolFamilyKind } from '../lib/chatSignals'
import { formatBytes } from '../lib/formatBytes'
import { extractUrls } from '../lib/extractUrls'
import { computeLineDiff, type DiffLine } from '../lib/lineDiff'
import { toast } from '../state/toast'
import { renderChatMarkdown } from '../lib/renderChatMarkdown'
import { handleChatLinkClick, openLinkifiedFilePath, readLinkifiedFileText } from '../lib/handleChatLinkClick'
import { assistantTurnPresentation } from '../lib/assistantTurnPresentation'
import { clampTurnText } from '../lib/chatVerbosity'
import { splitInjectedPreamble, describeInjectedBlocks } from '../lib/promptPreamble'
import { splitStopSignal } from '../lib/stopSignal'
import { formatAgo } from '../lib/formatTime'
import { MarkdownPreview } from './tabs/editor/MarkdownPreview'
import { InlineConsentTerminal } from './InlineConsentTerminal'
import { type Attribution } from '../lib/chatAttribution'
import type { TranscriptEventRef } from '../../preload/api'

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

// A file mention is previewable inline (via MarkdownPreview) only when it
// looks like markdown — code/other files still just open in the Editor.
const MARKDOWN_PATH_RE = /\.(?:md|markdown)(?::\d+)*$/i

// Same callout shape as UrlCallout, for bare file-path mentions (e.g. a pasted
// clipboard image path) — the label opens the file (reusing the same
// resolve/validate/open path as inline chat-file-link clicks) instead of
// external-opening a URL.
function FileCallout({
  path,
  cwd,
  inlinePreview = false,
}: {
  path: string
  cwd: string
  /** Renders a "Preview" toggle that shows the file's content inline via
   *  MarkdownPreview instead of navigating away to the Editor screen — set
   *  only by PromptSessionConversation (PRD 805), which has no Editor screen
   *  of its own to switch to. TerminalChat.tsx leaves this false/unset and
   *  keeps today's Open-in-Editor-only behavior. */
  inlinePreview?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
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
  const canPreview = inlinePreview && MARKDOWN_PATH_RE.test(path)
  const onTogglePreview = async () => {
    if (previewOpen) {
      setPreviewOpen(false)
      return
    }
    setPreviewOpen(true)
    if (previewText === null && !previewLoading) {
      setPreviewLoading(true)
      const text = await readLinkifiedFileText(path, cwd)
      setPreviewLoading(false)
      setPreviewText(text ?? '')
    }
  }
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs">
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
        {canPreview && (
          <button
            onClick={() => { void onTogglePreview() }}
            className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-fg-dim hover:bg-hi hover:text-fg"
          >
            {previewOpen ? 'Hide preview' : 'Preview'}
          </button>
        )}
        <button
          onClick={onCopy}
          className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-fg-dim hover:bg-hi hover:text-fg"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {canPreview && previewOpen && (
        <div
          className="mt-1 max-h-80 overflow-hidden rounded-lg border border-line"
          data-testid="file-inline-preview"
        >
          {previewLoading ? (
            <div className="px-3 py-2 text-xs text-fg-dim">Loading preview…</div>
          ) : (
            <MarkdownPreview text={previewText ?? ''} flush />
          )}
        </div>
      )}
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

// Collapsible variant of ToolUseTraceStrip — "used N tools" / "working · N
// tools" button that expands to the per-tool ×count chips, for surfaces
// (EpicDetail, PRD 827) that want the tool trace collapsed by default rather
// than always-visible. Kept in this file (not forked) per the API-reuse
// standard: same collapseToolUseRuns/runLabel/tone data as the inline strip.
export function CollapsibleToolStrip({
  items,
  running = false,
}: {
  items: ToolUseTrace[] | undefined
  running?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!items?.length) return null
  const runs = collapseToolUseRuns(items)
  const n = items.length
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="tool-strip-toggle"
        className="inline-flex items-center gap-1.5 rounded border border-line bg-elev px-2 py-1 font-mono text-[11px] text-fg-dim hover:bg-hi"
      >
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span>{(running ? 'working · ' : 'used ') + n + (n === 1 ? ' tool' : ' tools')}</span>
        {running && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1" data-testid="tool-strip-chips">
          {runs.map((u) => (
            <span
              key={u.id}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono font-medium ${TOOL_USE_TONE[u.kind]}`}
            >
              {TOOL_USE_ICON[u.kind]} {runLabel(u)}
            </span>
          ))}
        </div>
      )}
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

// "good"-tone pairing already used by Badge.tsx's `good` variant — reused
// here (rather than a new arbitrary green) for added diff lines, mirroring
// this file's own ERROR_TEXT/AMBER_TEXT contrast-checked pattern.
const DIFF_ADD_TEXT = 'text-sage-dark'
const DIFF_ADD_TINT = 'bg-sage/15'
const DIFF_REMOVE_TEXT = ERROR_TEXT
const DIFF_REMOVE_TINT = 'bg-[#b8443c]/10'

function DiffLineRow({ line }: { line: DiffLine }) {
  const sign = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
  const tint = line.type === 'add' ? DIFF_ADD_TINT : line.type === 'remove' ? DIFF_REMOVE_TINT : ''
  const text = line.type === 'add' ? DIFF_ADD_TEXT : line.type === 'remove' ? DIFF_REMOVE_TEXT : 'text-fg-dim'
  return (
    <div className={`whitespace-pre-wrap break-all px-2 py-0.5 font-mono text-[11px] ${tint} ${text}`}>
      <span className="select-none opacity-70">{sign} </span>
      {line.text}
    </div>
  )
}

// Collapsible file-diff card for an Edit/Write tool_use — the real-data
// equivalent of the Epics design mock's TDiff (epic-thread-mock.jsx). Accept/
// Retry/Reject buttons are intentionally out of scope: the mock's actions
// imply an accept/reject workflow this codebase has no backing action for —
// by the time this turn renders, the edit has already landed on disk.
export function DiffCard({ diff }: { diff: NonNullable<ToolUseTrace['diff']> }) {
  const [open, setOpen] = useState(false)
  // Memoized on the diff's own text — a ToolUseTrace's diff payload never
  // changes after it's recorded, but the parent Turn re-renders often while
  // a run streams, and the O(n·m) LCS table shouldn't redo on every one.
  const { lines, added, removed } = useMemo(
    () => computeLineDiff(diff.oldText, diff.newText),
    [diff.oldText, diff.newText],
  )
  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-line" data-testid="diff-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="diff-card-toggle"
        className="flex w-full items-center gap-1.5 bg-elev px-2 py-1 font-mono text-[11px] text-fg-dim hover:bg-hi"
      >
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{diff.filePath}</span>
        <span className={DIFF_ADD_TEXT}>+{added}</span>
        <span className={DIFF_REMOVE_TEXT}>-{removed}</span>
      </button>
      {open && (
        <div className="max-h-96 overflow-y-auto bg-bg" data-testid="diff-card-lines">
          {lines.map((line, i) => (
            <DiffLineRow key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  )
}

// Renders one DiffCard per toolUse that carries an Edit/Write diff payload —
// multiple edits within the same turn each get their own card, never merged.
function DiffCards({ items }: { items: ToolUseTrace[] | undefined }) {
  const withDiffs = items?.filter((u) => u.diff) ?? []
  if (!withDiffs.length) return null
  return (
    <>
      {withDiffs.map((u) => (
        <DiffCard key={u.id} diff={u.diff!} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Shared turn frame (PRD chat-simplified-conversion-frame). Every turn kind —
// conversation bubbles, signal cards, event-chain cards — reads the SAME
// attribution data through AttributionChips; TurnFrame additionally supplies
// the Header/Body/Footer zone layout for kinds that had no header/footer of
// their own (the generic Signal card and every renderEventTurn kind below).
// Conversation bubbles (user/assistant/question/notice) already have their
// own header row from PRD 845/914 — those fold AttributionChips into that
// EXISTING row (see the `claude · <age>` caption spans further down) rather
// than wrapping in a second TurnFrame, per this PRD's explicit "don't
// duplicate the caption layer" requirement.
// ---------------------------------------------------------------------------

const ATTRIBUTION_CHIP_BASE =
  'inline-flex max-w-[160px] items-center gap-1 truncate rounded border px-1.5 py-0.5 font-mono text-[10px]'
const ATTRIBUTION_CHIP_NEUTRAL = 'border-line bg-elev text-fg-dim'

/** Header chip row for the attribution fields classifyTranscriptLine.cjs's
 *  makeRaw() preserves on every transcript-feed event (attributionSkill/
 *  Plugin/McpServer/McpTool, effort, gitBranch, isSidechain, isMeta,
 *  isApiErrorMessage, interruptedByShutdown) — see chatAttribution.ts. Renders
 *  nothing (not even an empty row) when the turn carries no attribution at
 *  all, or when every field on it is absent. */
export function AttributionChips({ attribution }: { attribution?: Attribution }) {
  if (!attribution) return null
  const chips: { key: string; label: string; tint?: string }[] = []
  if (attribution.attributionSkill) chips.push({ key: 'skill', label: `🧩 ${attribution.attributionSkill}` })
  if (attribution.attributionPlugin) chips.push({ key: 'plugin', label: `🔌 ${attribution.attributionPlugin}` })
  if (attribution.attributionMcpServer) chips.push({ key: 'mcp-server', label: `🔌 ${attribution.attributionMcpServer}` })
  if (attribution.attributionMcpTool) chips.push({ key: 'mcp-tool', label: `⚙ ${attribution.attributionMcpTool}` })
  if (attribution.effort) chips.push({ key: 'effort', label: `effort:${attribution.effort}` })
  if (attribution.gitBranch) chips.push({ key: 'branch', label: `⎇ ${attribution.gitBranch}` })
  if (attribution.isSidechain) chips.push({ key: 'sidechain', label: 'sidechain' })
  if (attribution.isMeta) chips.push({ key: 'meta', label: 'meta' })
  if (attribution.isApiErrorMessage) {
    chips.push({ key: 'api-error', label: 'API error', tint: `${ERROR_TINT} ${ERROR_TEXT}` })
  }
  if (attribution.interruptedByShutdown) {
    chips.push({ key: 'interrupted', label: 'interrupted', tint: `${ERROR_TINT} ${ERROR_TEXT}` })
  }
  if (!chips.length) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="attribution-chips">
      {chips.map((c) => (
        <span
          key={c.key}
          title={c.label}
          data-testid={`attribution-chip-${c.key}`}
          className={`${ATTRIBUTION_CHIP_BASE} ${c.tint ?? ATTRIBUTION_CHIP_NEUTRAL}`}
        >
          {c.label}
        </span>
      ))}
    </div>
  )
}

/**
 * Footer affordances shared by every turn kind: 'Show raw' re-reads the
 * EXACT untruncated JSONL line for this turn via the byte-reference/paging
 * path (window.api.transcripts.readRef) — never a re-serialized
 * approximation of the parsed turn/signal — and 'Copy' copies whatever is
 * currently on screen (the raw line once loaded, else the given fallback
 * text). Both are omitted when this turn has no ref and no fallback text to
 * offer, so the footer zone collapses to nothing rather than two dead
 * buttons.
 */
export function TurnRawFooter({
  turnRef,
  copyText,
  testId,
}: {
  turnRef?: TranscriptEventRef | null
  copyText?: string
  testId?: string
}) {
  const [rawOpen, setRawOpen] = useState(false)
  const [rawText, setRawText] = useState<string | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!turnRef && !copyText) return null

  const onToggleRaw = async () => {
    if (rawOpen) {
      setRawOpen(false)
      return
    }
    setRawOpen(true)
    if (rawText === null && turnRef && !rawLoading) {
      setRawLoading(true)
      try {
        const res = await window.api.transcripts.readRef(turnRef)
        setRawText(res.ok && res.text !== undefined ? res.text : '(raw line unavailable)')
      } catch {
        setRawText('(raw line unavailable)')
      } finally {
        setRawLoading(false)
      }
    }
  }

  const onCopy = () => {
    const text = rawOpen && rawText ? rawText : (copyText ?? '')
    if (!text) return
    copyToClipboard(text, (ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1100)
      } else {
        toast.error('Copy failed')
      }
    })
  }

  return (
    <div>
      <div
        className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-fg-faint"
        data-testid={testId ?? 'turn-raw-footer'}
      >
        {turnRef && (
          <button
            type="button"
            onClick={() => { void onToggleRaw() }}
            data-testid="turn-raw-footer-show-raw"
            className="rounded border border-line px-1.5 py-0.5 hover:bg-hi hover:text-fg"
          >
            {rawOpen ? 'Hide raw' : 'Show raw'}
          </button>
        )}
        <button
          type="button"
          onClick={onCopy}
          data-testid="turn-raw-footer-copy"
          className="rounded border border-line px-1.5 py-0.5 hover:bg-hi hover:text-fg"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {rawOpen && (
        <pre
          data-testid="turn-raw-footer-raw"
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-bg px-2 py-1.5 font-mono text-[11px] text-fg-dim"
        >
          {rawLoading ? 'Loading…' : (rawText ?? '')}
        </pre>
      )}
    </div>
  )
}

/**
 * The three-zone frame (Header / Body / Footer) — used directly by
 * renderEventTurn's dispatch (below) to wrap every event-kind renderer with
 * a consistent badge/timestamp/attribution header and a Show-raw/Copy
 * footer, without touching each kind's own body markup or test ids. Zones
 * are always structurally present in this JSX but an empty one renders
 * nothing: no badge+no timestamp+no attribution means no header row at all
 * (not an empty bordered strip), and no ref+no copy text means no footer row.
 */
export function TurnFrame({
  badge,
  timestamp,
  attribution,
  turnRef,
  copyText,
  testId,
  children,
}: {
  badge?: ReactNode
  timestamp?: number
  attribution?: Attribution
  turnRef?: TranscriptEventRef | null
  copyText?: string
  testId?: string
  children: ReactNode
}) {
  const hasHeader = !!badge || timestamp !== undefined || !!attribution
  return (
    <div className="mb-1.5" data-testid={testId ?? 'turn-frame'}>
      {hasHeader && (
        <div
          className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-fg-faint"
          data-testid="turn-frame-header"
        >
          {badge}
          {timestamp !== undefined && <span>{formatAgo(timestamp, Date.now())}</span>}
          <AttributionChips attribution={attribution} />
        </div>
      )}
      <div data-testid="turn-frame-body">{children}</div>
      <TurnRawFooter turnRef={turnRef} copyText={copyText} testId="turn-frame-footer" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// role:'event' typed renderers (PRD chat-typed-event-renderers). chat.ts's
// ingestTranscriptEvent lands every JSONL transcript-feed event with no
// dedicated turn role (mode, queue-operation, attachment/*, tool_use, usage,
// ai-title, …) as a role:'event' turn carrying `kind` + a bounded `signal`
// (lib/chatSignals.ts) + `ref` (byte range for re-reading the full untruncated
// line on expand). renderEventTurn below is the single place those kinds fan
// out to a typed renderer — see its own comment for the router-never-filter
// contract.
// ---------------------------------------------------------------------------

function signalPreviewObject(turn: ChatTurn): Record<string, unknown> {
  const obj: Record<string, unknown> = { kind: turn.kind ?? 'event' }
  const s = turn.signal
  if (s) {
    for (const [k, v] of Object.entries(s)) {
      if (v !== undefined) obj[k] = v
    }
  } else if (turn.text) {
    obj.preview = turn.text
  } else {
    obj.preview = '(no data)'
  }
  return obj
}

// CORE: the generic Signal card — the forward-compatibility fallback for any
// event kind (or attachment subtype) with no dedicated renderer. Renders the
// kind name as a header plus a pretty-printed JSON body, collapsed to 3 lines
// with an expand affordance that re-reads the full untruncated line from disk
// via the turn's ref. Never throws on a malformed/undefined signal — falls
// back to the bounded previewText or an explicit "(no data)" empty state.
function GenericSignalCard({ turn }: { turn: ChatTurn }) {
  const [open, setOpen] = useState(false)
  const [fullText, setFullText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const preview = useMemo(() => JSON.stringify(signalPreviewObject(turn), null, 2), [turn])
  const previewLines = preview.split('\n')
  const collapsed = previewLines.slice(0, 3).join('\n')
  const canExpand = previewLines.length > 3 || !!turn.ref
  const onToggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (fullText === null && turn.ref && !loading) {
      setLoading(true)
      try {
        const res = await window.api.transcripts.readRef(turn.ref)
        setFullText(res.ok && res.text ? fullSignalText(turn.kind ?? '', turn.signal?.subtype, res.text) : preview)
      } catch {
        setFullText(preview)
      } finally {
        setLoading(false)
      }
    }
  }
  return (
    <div
      className="mb-1.5 overflow-hidden rounded-lg border border-line"
      data-testid="signal-card"
      data-signal-kind={turn.kind ?? ''}
    >
      <div className="flex items-center justify-between gap-2 bg-elev px-2 py-1 font-mono text-[10.5px] text-fg-dim">
        <span className="truncate">{turn.kind ?? 'event'}</span>
        {canExpand && (
          <button
            type="button"
            onClick={() => { void onToggle() }}
            data-testid="signal-card-toggle"
            className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] hover:bg-hi"
          >
            {open ? 'Collapse' : 'Expand'}
          </button>
        )}
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-bg px-2 py-1.5 font-mono text-[11px] text-fg-dim">
        {open ? (loading ? 'Loading…' : (fullText ?? preview)) : collapsed}
      </pre>
    </div>
  )
}

// mode/permissionMode: a state transition is a line, not a card.
const EVENT_DIVIDER_LABEL: Record<string, string> = { mode: 'mode', permissionMode: 'permission' }

export function EventDivider({ label, value }: { label: string; value?: string }) {
  return (
    <div className="my-1 flex items-center gap-2" data-testid="event-divider">
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">
        — {label} → {value ?? '(unknown)'} —
      </span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  )
}

function QueueOperationChip({ turn }: { turn: ChatTurn }) {
  return (
    <div
      className="mb-1 inline-flex max-w-full items-center gap-1.5 rounded border border-line bg-elev px-2 py-0.5 font-mono text-[10.5px] text-fg-dim"
      data-testid="queue-operation-chip"
    >
      <span>{turn.signal?.value ?? 'queue'}</span>
      {turn.signal?.text && <span className="min-w-0 truncate">{turn.signal.text}</span>}
    </div>
  )
}

function QueuedCommandChip({ turn }: { turn: ChatTurn }) {
  return (
    <div
      className="mb-1 inline-flex max-w-full items-center gap-1.5 rounded border border-line bg-elev px-2 py-0.5 font-mono text-[10.5px] text-fg-dim"
      data-testid="queued-command-chip"
    >
      <span aria-hidden>⏳</span>
      <span>{turn.signal?.value ?? 'queued'}</span>
      {turn.signal?.text && <span className="min-w-0 truncate">{turn.signal.text}</span>}
    </div>
  )
}

function SnapshotMarker({ turn }: { turn: ChatTurn }) {
  return (
    <div className="py-0.5 text-center font-mono text-[10.5px] text-fg-faint" data-testid="snapshot-marker">
      — restore point{typeof turn.signal?.count === 'number' ? ` · ${turn.signal.count} file${turn.signal.count === 1 ? '' : 's'}` : ''} —
    </div>
  )
}

function TaskReminderStrip({ turn }: { turn: ChatTurn }) {
  return (
    <div className="py-0.5 font-mono text-[10.5px] text-fg-faint" data-testid="task-reminder-strip">
      📋 task reminder{typeof turn.signal?.count === 'number' && turn.signal.count > 0 ? ` · ${turn.signal.count} item${turn.signal.count === 1 ? '' : 's'}` : ''}
    </div>
  )
}

function CommandPermissionsChip({ turn }: { turn: ChatTurn }) {
  const names = turn.signal?.names ?? []
  return (
    <div
      className={`mb-1 inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10.5px] ${AMBER_TINT} ${AMBER_TEXT}`}
      data-testid="command-permissions-chip"
    >
      <span aria-hidden>🔒</span>
      <span>{turn.signal?.count ?? names.length} allowed command{(turn.signal?.count ?? names.length) === 1 ? '' : 's'}</span>
    </div>
  )
}

function ThinkingBlock({ turn }: { turn: ChatTurn }) {
  const text = turn.signal?.text ?? ''
  if (!text) return null
  return (
    <div className="mb-1.5 border-l-2 border-line pl-2 text-xs italic text-fg-dim" data-testid="thinking-block">
      {text}
    </div>
  )
}

function McpInstructionsCard({ turn }: { turn: ChatTurn }) {
  const signal = turn.signal
  const serverName = signal?.names?.[0] ?? 'MCP server'
  const html = useMemo(() => renderChatMarkdown(signal?.text ?? ''), [signal?.text])
  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-accent/30" data-testid="mcp-instructions-card">
      <div className="bg-accent/10 px-2 py-1 font-mono text-[10.5px] text-accent">
        <span aria-hidden>🔌</span> {serverName}
      </div>
      <div
        className="prose-chat bg-elev px-2 py-1.5 text-xs leading-relaxed text-fg"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

// count chip → expandable name grid, shared by deferred_tools_delta,
// agent_listing_delta, skill_listing. Expand re-reads the full uncapped name
// list from disk (fullSignalNames) since the ingest-time signal caps at
// SIGNAL_NAMES_MAX.
function NameCountChip({ turn, label }: { turn: ChatTurn; label: string }) {
  const [open, setOpen] = useState(false)
  const [namesFull, setNamesFull] = useState<string[] | null>(null)
  const signal = turn.signal
  const added = signal?.count ?? signal?.names?.length ?? 0
  const removed = signal?.removedCount ?? signal?.removedNames?.length ?? 0
  const onToggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (namesFull === null && turn.ref) {
      const res = await window.api.transcripts.readRef(turn.ref)
      if (res.ok && res.text) setNamesFull(fullSignalNames(signal?.subtype, res.text) ?? signal?.names ?? [])
    }
  }
  const displayNames = namesFull ?? signal?.names ?? []
  const hasAny = added > 0 || removed > 0 || displayNames.length > 0
  return (
    <div className="mb-1.5" data-testid="name-count-chip" data-signal-subtype={signal?.subtype ?? ''}>
      <button
        type="button"
        onClick={() => { void onToggle() }}
        className="inline-flex items-center gap-1.5 rounded border border-line bg-elev px-2 py-0.5 font-mono text-[10.5px] text-fg-dim hover:bg-hi"
      >
        {added > 0 && <span>+{added} {label}</span>}
        {removed > 0 && <span>−{removed} {label}</span>}
        {!hasAny && <span>{label}</span>}
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1" data-testid="name-count-grid">
          {displayNames.length === 0 ? (
            <span className="font-mono text-[10px] text-fg-faint">(no names)</span>
          ) : (
            displayNames.map((n) => (
              <span key={n} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
                {n}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// tool_result: outcome chip (success/error) + first line + byte count,
// expanding to the full untruncated result body. Reuses DiffCard directly
// when the result carries an Edit-style diff payload.
function ToolResultChip({ turn }: { turn: ChatTurn }) {
  const [open, setOpen] = useState(false)
  const [fullText, setFullText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const signal = turn.signal
  if (signal?.diff) return <DiffCard diff={signal.diff} />
  const line = signal?.value ?? ''
  const bytes = (turn.text ?? '').length
  const onToggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (fullText === null && turn.ref && !loading) {
      setLoading(true)
      const res = await window.api.transcripts.readRef(turn.ref)
      setLoading(false)
      setFullText(res.ok && res.text ? fullSignalText('tool_result', undefined, res.text) : line)
    }
  }
  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-line" data-testid="tool-result-chip">
      <button
        type="button"
        onClick={() => { void onToggle() }}
        className={`flex w-full items-center gap-1.5 px-2 py-1 font-mono text-[10.5px] hover:bg-hi ${
          signal?.isError ? `${ERROR_TINT} ${ERROR_TEXT}` : 'bg-elev text-fg-dim'
        }`}
      >
        <span aria-hidden>{signal?.isError ? '✗' : '✓'}</span>
        <span className="min-w-0 flex-1 truncate text-left">{line || '(empty result)'}</span>
        <span className="shrink-0">{formatBytes(bytes)}</span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-bg px-2 py-1.5 font-mono text-[11px] text-fg-dim">
          {loading ? 'Loading…' : (fullText ?? line)}
        </pre>
      )}
    </div>
  )
}

// tool_use/todo_write/plan/agent_spawn: the same icon+label chip the live
// assistant tool trace uses (ToolUseTraceStrip), fed a single-item run —
// isToolFamilyKind is what routes these four kinds here.
function ToolFamilyChip({ turn }: { turn: ChatTurn }) {
  const tool = turn.signal?.tool
  if (!tool) return null
  return <ToolUseTraceStrip items={[{ id: turn.id, kind: tool.kind, label: tool.label }]} />
}

/**
 * role:'event' dispatch — maps a JSONL transcript-feed event's `kind` (and,
 * for 'attachment', its signal.subtype) to a typed renderer.
 *
 * ROUTER, NEVER A FILTER: every `default` branch below (outer and the nested
 * attachment one) is the forward-compatibility guarantee for a kind/subtype
 * this file has no dedicated renderer for yet — a future CLI event, a typo'd
 * kind, anything — so it always renders the generic Signal card rather than
 * silently dropping the turn. The ONLY turns ever omitted from the feed are
 * the two exact-duplicate suppressions in visibleFeedTurns() below (a
 * repeated ai-title, a last-prompt duplicating the immediately preceding user
 * turn) — never a decision made here, and never based on kind.
 */
function renderEventTurn(turn: ChatTurn): ReactNode {
  const kind = turn.kind
  const signal = turn.signal
  if (isToolFamilyKind(kind)) return <ToolFamilyChip turn={turn} />
  switch (kind) {
    case 'mode':
    case 'permissionMode':
      return <EventDivider label={EVENT_DIVIDER_LABEL[kind] ?? kind} value={signal?.value} />
    case 'queue-operation':
      return <QueueOperationChip turn={turn} />
    case 'file-history-snapshot':
      return <SnapshotMarker turn={turn} />
    case 'content_thinking':
      return <ThinkingBlock turn={turn} />
    case 'tool_result':
      return <ToolResultChip turn={turn} />
    case 'attachment': {
      switch (signal?.subtype) {
        case 'deferred_tools_delta':
          return <NameCountChip turn={turn} label="tools" />
        case 'agent_listing_delta':
          return <NameCountChip turn={turn} label="agents" />
        case 'skill_listing':
          return <NameCountChip turn={turn} label="skills" />
        case 'mcp_instructions_delta':
          return <McpInstructionsCard turn={turn} />
        case 'task_reminder':
          return <TaskReminderStrip turn={turn} />
        case 'command_permissions':
          return <CommandPermissionsChip turn={turn} />
        case 'edited_text_file':
          return signal?.diff ? <DiffCard diff={signal.diff} /> : <GenericSignalCard turn={turn} />
        case 'queued_command':
          return <QueuedCommandChip turn={turn} />
        default:
          // EDGE: an attachment subtype not in the list above (or no subtype
          // at all — a malformed attachment payload) falls through here.
          return <GenericSignalCard turn={turn} />
      }
    }
    default:
      // Unknown/future event kind (ai-title, last-prompt, usage, or anything
      // not yet given a dedicated renderer) — falls through to the generic
      // Signal card. This branch is the executable statement of the
      // forward-compat guarantee: a completely made-up kind still renders.
      return <GenericSignalCard turn={turn} />
  }
}

/**
 * Drops the two — and only two — permitted exact-duplicate event turns:
 * a repeated ai-title (shown once, as the session title) and a last-prompt
 * that duplicates the immediately preceding user turn. No other kind is ever
 * suppressed here — everything else reaches renderEventTurn's router. Pure
 * function of the full turns array so both EpicDetail and tests share one
 * implementation of "immediately preceding user turn" (nearest user-role
 * turn scanning backward, skipping only role:'event' turns in between).
 */
export function visibleFeedTurns(turns: ChatTurn[]): ChatTurn[] {
  const seenAiTitles = new Set<string>()
  let lastUserText: string | undefined
  const out: ChatTurn[] = []
  for (const t of turns) {
    if (t.role === 'user') lastUserText = t.text
    if (t.role === 'event') {
      if (t.kind === 'ai-title') {
        const text = t.signal?.text
        if (text !== undefined) {
          if (seenAiTitles.has(text)) continue
          seenAiTitles.add(text)
        }
      } else if (t.kind === 'last-prompt') {
        const text = t.signal?.text
        if (text !== undefined && text === lastUserText) continue
      }
    }
    out.push(t)
  }
  return out
}

/** Nearest preceding turn's text when it's a plain user prompt, scanning
 *  backward from `index` and skipping over role:'event' turns (metadata, not
 *  a real conversational reply) — stops and returns undefined at the first
 *  non-event, non-user turn it hits. Shared by the consent-notice Retry
 *  button (via the `precedingUserPrompt` prop below) and last-prompt
 *  suppression above. */
export function nearestPrecedingUserPrompt(turns: ChatTurn[], index: number): string | undefined {
  for (let j = index - 1; j >= 0; j--) {
    const t = turns[j]
    if (t.role === 'event') continue
    return t.role === 'user' ? t.text : undefined
  }
  return undefined
}

function TurnComponent({
  turn,
  cwd,
  tabId,
  sessionId,
  runActive = false,
  consentActionDisabled = false,
  enableRawSessionActions = true,
  inlineFilePreview = false,
  toolStripVariant = 'inline',
  needsDecisionStyle = false,
  precedingUserPrompt,
  clampBodyChars = null,
  injectedPreamble = 'shown',
  onQuote,
}: {
  turn: ChatTurn
  cwd: string
  tabId: string
  /** The tab's claude session id — needed only to submit an inline needs-input
   *  answer button through the same chat send() path the composer uses. */
  sessionId: string
  runActive?: boolean
  consentActionDisabled?: boolean
  /** False for views with no backing SessionTab/PTY (e.g. PromptSessionConversation,
   *  PRD 804) — hides the "Grant consent" action, which spawns an inline
   *  InlineConsentTerminal PTY widget against a real tab's sessionId and has
   *  no equivalent there. */
  enableRawSessionActions?: boolean
  /** Renders file/markdown references with an inline MarkdownPreview toggle
   *  instead of Open-in-Editor-only — set only by PromptSessionConversation
   *  (PRD 805), which has no Editor screen to navigate to. */
  inlineFilePreview?: boolean
  /** 'collapsible' renders CollapsibleToolStrip ("used N tools" toggle)
   *  instead of the always-expanded ToolUseTraceStrip — set only by
   *  EpicDetail (PRD 827). 'hidden' omits the strip AND the diff cards
   *  entirely — set only by EpicDetail at 'summary' verbosity
   *  (lib/chatVerbosity.ts), where the feed is deliberately conversation-only.
   *  TerminalChat.tsx/PromptSessionConversation.tsx keep the default 'inline'
   *  behavior unchanged. */
  toolStripVariant?: 'inline' | 'collapsible' | 'hidden'
  /** Red-tinted "NEEDS YOUR DECISION" styling for question turns instead of
   *  the default amber "Needs your answer" — set only by EpicDetail
   *  (PRD 827), per the Epics design spec's needs-you treatment. */
  needsDecisionStyle?: boolean
  /** The text of the chat turn immediately preceding this one, ONLY when that
   *  turn is a plain user prompt — set by the caller (which owns the full
   *  turns array; this component only ever sees one turn at a time). Used
   *  exclusively by the consent-notice 'Retry' button below to resend the
   *  prompt that originally triggered the MCP consent denial. Left undefined
   *  when there's no confidently-identifiable preceding prompt (e.g. the
   *  notice is the first turn) — the Retry button is omitted in that case
   *  rather than guessing. */
  precedingUserPrompt?: string
  /** Clamp an ASSISTANT bubble's prose to this many characters, with an
   *  inline "Show full message" toggle that restores the untruncated text
   *  from the same `turn.text` already in hand (no re-fetch). null/undefined
   *  = never clamp, which is every caller except EpicDetail at 'summary'
   *  verbosity (lib/chatVerbosity.ts's ASSISTANT_CLAMP_CHARS). Deliberately
   *  ignored for question/notice/error turns — a turn that is asking the
   *  human something is never abbreviated. */
  clampBodyChars?: number | null
  /** 'hidden' collapses chatRunner's own injected instruction blocks
   *  (lib/promptPreamble.ts) out of a USER bubble, leaving a tiny ≡ glyph
   *  that expands them in place. Default 'shown' = today's behavior, i.e.
   *  the raw prompt exactly as the CLI recorded it — every caller except
   *  EpicDetail below 'verbose' verbosity. Purely presentational: the turn's
   *  own `text` is never rewritten, so the raw footer's Copy/Show-raw still
   *  yield the byte-exact prompt that was sent. (Quote deliberately narrows
   *  to the human's own words — quoting boilerplate back at the agent is
   *  never what's wanted.) */
  injectedPreamble?: 'shown' | 'hidden'
  /** Shows a hover "Quote" button on this turn that calls onQuote(turn.text)
   *  when clicked — omitted (no button rendered) when not passed, so callers
   *  with no reply-context affordance (Terminal transcript, raw session view)
   *  are unaffected. Set only by EpicDetail's Discussion timeline. */
  onQuote?: (text: string) => void
}) {
  // Declared unconditionally (rules of hooks) even though only the assistant
  // 'text' branch below uses them — the early returns for other turn roles
  // happen after these hooks run.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const presentation = turn.role === 'assistant' ? assistantTurnPresentation(turn, runActive) : null
  // Only needed to disable/enable the question turn's inline answer buttons
  // while a later run is already in flight for this tab.
  const chatRunning = useChat((s) => s.chats[tabId]?.running ?? false)
  // Only meaningful for the 'notice' branch below, but declared up here
  // (rules of hooks) since earlier roles return before that branch runs.
  // onConsentGranted/onConsentClose are stabilized with useCallback because
  // InlineConsentTerminal's spawn effect depends on `onGranted`'s identity —
  // a fresh closure on every re-render (e.g. from this tab's shared
  // `chatRunning` selector flipping) would tear the widget's effect down and
  // never respawn it (spawnedRef guards re-spawn to the first mount only).
  const [consentExpanded, setConsentExpanded] = useState(false)
  const [consentGranted, setConsentGranted] = useState(false)
  // Per-turn override of `clampBodyChars` — reset whenever the caller changes
  // the clamp (i.e. the user moved the verbosity dial), so switching to
  // Summary re-collapses turns they had expanded under the previous level.
  const [bodyExpanded, setBodyExpanded] = useState(false)
  useEffect(() => { setBodyExpanded(false) }, [clampBodyChars])
  // Same reset discipline for the user bubble's injected-preamble disclosure.
  const [preambleOpen, setPreambleOpen] = useState(false)
  useEffect(() => { setPreambleOpen(false) }, [injectedPreamble])
  const onConsentGranted = useCallback(() => {
    toast.info('Consent granted — you can retry the run now.')
    setConsentExpanded(false)
    setConsentGranted(true)
  }, [])
  const onConsentClose = useCallback(() => setConsentExpanded(false), [])
  useEffect(() => {
    if (turn.role === 'assistant' && presentation === 'text' && bodyRef.current) {
      linkifyFilePaths(bodyRef.current)
    }
  }, [turn.role, presentation, turn.text, clampBodyChars, bodyExpanded])

  if (turn.role === 'user') {
    // chatRunner prepends ~1.4k chars of fixed instruction blocks to every
    // prompt; the CLI's JSONL records them, so the transcript-derived user
    // turn is mostly boilerplate with the human's sentence at the bottom.
    // Split it out for display only — `turn.text` is untouched, so Quote and
    // the raw footer still carry the exact prompt that was sent.
    const split = injectedPreamble === 'hidden' ? splitInjectedPreamble(turn.text) : null
    const hasPreamble = !!split?.preamble
    const shownText = hasPreamble && !preambleOpen ? split!.body : turn.text
    return (
      <div className="group grid justify-items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-fg-faint">you · {formatAgo(turn.at, Date.now())}</span>
          {hasPreamble && (
            <button
              type="button"
              onClick={() => setPreambleOpen((o) => !o)}
              data-testid="chat-turn-preamble-toggle"
              aria-expanded={preambleOpen}
              aria-label={
                preambleOpen
                  ? 'Hide the Session-Manager instructions prepended to this prompt'
                  : 'Show the Session-Manager instructions prepended to this prompt'
              }
              title={`${preambleOpen ? 'Hide' : 'Show'} the ${describeInjectedBlocks(split!.blockKeys)} ` +
                'instructions Session-Manager prepended to this prompt'}
              className={`rounded border px-1 font-mono text-[10px] leading-[14px] ${
                preambleOpen ? 'border-line bg-hi text-fg-dim' : 'border-transparent text-fg-faint hover:border-line hover:text-fg-dim'
              }`}
            >
              ≡
            </button>
          )}
          <AttributionChips attribution={turn.attribution} />
        </div>
        {hasPreamble && preambleOpen && (
          <div
            data-testid="chat-turn-preamble"
            className="max-w-[80%] whitespace-pre-wrap break-words rounded-lg border border-dashed border-rule px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-faint"
          >
            {split!.preamble}
          </div>
        )}
        <div className="max-w-[80%] break-words rounded-tl-lg rounded-tr-lg rounded-bl-lg rounded-br-sm bg-accent/15 px-3 py-2 text-sm text-fg whitespace-pre-wrap">
          {shownText}
        </div>
        {onQuote && (
          <button
            type="button"
            // Quote the HUMAN's words, never the injected boilerplate — the
            // raw footer below still exposes the byte-exact sent prompt.
            onClick={() => onQuote(split?.body ?? turn.text)}
            data-testid="chat-turn-quote"
            title="Quote this message in your reply"
            aria-label="Quote this message"
            className="font-mono text-[10.5px] text-fg-faint opacity-0 hover:text-accent group-hover:opacity-100"
          >
            Quote
          </button>
        )}
        <TurnRawFooter turnRef={turn.ref} copyText={turn.text} testId="chat-turn-user-footer" />
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
    const tint = needsDecisionStyle ? ERROR_TINT : AMBER_TINT
    const text = needsDecisionStyle ? ERROR_TEXT : AMBER_TEXT
    const label = needsDecisionStyle ? 'NEEDS YOUR DECISION' : 'Needs your answer'
    const options = turn.questions ?? [turn.text]
    const onAnswer = (answer: string) => {
      useChat.getState().send({ tabId, sessionId, cwd, prompt: answer })
    }
    return (
      <div className="flex max-w-[90%] items-start gap-2" data-testid="chat-turn-question">
        <div className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg border text-xs font-semibold ${tint} ${text}`}>
          C
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] text-fg-faint">
            <span>claude · {formatAgo(turn.at, Date.now())}</span>
            <AttributionChips attribution={turn.attribution} />
          </div>
          {toolStripVariant === 'hidden' ? null : toolStripVariant === 'collapsible' ? (
            <CollapsibleToolStrip items={turn.toolUses} />
          ) : (
            <ToolUseTraceStrip items={turn.toolUses} />
          )}
          <div className={`rounded-tl-sm rounded-tr-lg rounded-br-lg rounded-bl-lg border px-4 py-3 text-sm ${tint} ${text}`}>
            <div
              className={`mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${needsDecisionStyle ? 'font-mono' : ''} ${text}`}
            >
              <span aria-hidden>❓</span>
              {label}
            </div>
            <ul className="list-disc space-y-1 pl-5">
              {options.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
            <div className={`mt-2 flex flex-wrap gap-2 border-t pt-2 ${tint}`}>
              {options.map((q, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onAnswer(q)}
                  disabled={chatRunning}
                  title={q}
                  className={`max-w-full truncate rounded-lg border border-current px-3 py-1.5 text-xs font-semibold hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent ${text}`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }
  if (turn.role === 'notice') {
    const isConsentNotice = turn.text.includes(CONSENT_NOTICE_MARKER)
    const onGrantConsent = async () => {
      // Same pre-condition wakeTab enforces at sessions.ts:220-227 (PRD 718) —
      // a headless chat run still writing to this sessionId's --resume
      // transcript must be torn down before anything else attaches to the
      // same PTY. Unlike the old path, nothing here mints a new tab/Terminal
      // mount — the widget below attaches inline in chat.
      if (useChat.getState().chats[tabId]?.running) {
        await window.api.chat.cancel(tabId)
        toast.info('Cancelled the in-progress chat run to open a live session.')
      }
      setConsentExpanded(true)
    }
    const onRetry = () => {
      if (!precedingUserPrompt) return
      useChat.getState().send({ tabId, sessionId, cwd, prompt: precedingUserPrompt })
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
            {consentExpanded ? (
              <div className="mt-1">
                <InlineConsentTerminal
                  sessionId={sessionId}
                  cwd={cwd}
                  command="/design consent"
                  onGranted={onConsentGranted}
                  onClose={onConsentClose}
                />
              </div>
            ) : consentGranted ? (
              precedingUserPrompt ? (
                <button
                  onClick={onRetry}
                  disabled={chatRunning}
                  title={chatRunning ? 'Wait for the current run to finish before retrying' : 'Resend your original prompt now that consent is granted'}
                  className={`rounded border px-2 py-1 text-xs font-medium hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent ${AMBER_TEXT} border-current`}
                >
                  Retry →
                </button>
              ) : null
            ) : (
              <button
                onClick={() => { void onGrantConsent() }}
                disabled={consentActionDisabled}
                title={consentActionDisabled ? 'Cancel or wait for the current run before granting consent' : 'Grant MCP consent inline, without leaving chat'}
                className={`rounded border px-2 py-1 text-xs font-medium hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent ${AMBER_TEXT} border-current`}
              >
                Grant consent →
              </button>
            )}
          </div>
        )}
      </div>
    )
  }
  if (turn.role === 'event') {
    return (
      <div data-testid="chat-turn-event">
        <TurnFrame
          badge={
            <span
              data-testid="turn-kind-badge"
              className="rounded border border-line bg-elev px-1.5 py-0.5 text-[10px] font-semibold text-fg-dim"
            >
              {turn.kind ?? 'event'}
            </span>
          }
          timestamp={turn.at}
          attribution={turn.attribution}
          turnRef={turn.ref}
          copyText={turn.signal?.text ?? turn.text}
        >
          {renderEventTurn(turn)}
        </TurnFrame>
      </div>
    )
  }
  // assistant — render the run's final message verbatim (markdown), guarded
  // against empty text (e.g. a resumed turn that opens with a non-rendered
  // thinking block before any visible text arrives — see
  // session-manager-operations/feedback/2026-07-21-chat-empty-assistant-bubble.md).
  if (presentation === 'suppress') return null

  // A stop-signal-ended turn (see stopSignal.ts) may still carry its trailing
  // `<<<SM_NEEDS_INPUT>>>` + questions-JSON block when this is the JSONL feed
  // copy — the separate 'question' turn already renders those questions as
  // its own card, so showing raw protocol JSON here too would be noise (and
  // was the third rendering of the same content before the identity fix in
  // state/chat.ts). `turn.text` itself is untouched — Quote/Show-raw still
  // yield the byte-exact record — only this local display copy is stripped.
  const bodyText = splitStopSignal(turn.text)?.body ?? turn.text

  // Clamped bodies extract their callouts from the SHOWN text only — a URL or
  // file path that lives in the withheld tail would otherwise render a callout
  // for something not on screen.
  const clamped = clampTurnText(bodyText, bodyExpanded ? null : clampBodyChars)
  const shownText = clamped.body
  const urls = extractUrls(shownText)
  const filePaths = extractFilePaths(shownText)
  const isPlan = hasMarkdownList(shownText)
  const shownHtml = useMemo(() => renderChatMarkdown(shownText), [shownText])
  const isRunning = presentation === 'working'
  // isApiErrorMessage/interruptedByShutdown both mean this turn is
  // incomplete (a dropped API response, a shutdown mid-stream) — reuse the
  // same ERROR_TINT/ERROR_TEXT the 'error' role and the two attribution
  // chips already use, so an incomplete turn reads as visually distinct from
  // a normal completed one rather than only being flagged via a small chip.
  const isIncomplete = !!(turn.attribution?.isApiErrorMessage || turn.attribution?.interruptedByShutdown)
  const bubbleCorners = 'rounded-tl-sm rounded-tr-lg rounded-br-lg rounded-bl-lg'
  const bubbleTone = isIncomplete ? `${ERROR_TINT} ${ERROR_TEXT}` : 'border-line bg-elev text-fg'
  return (
    <div className="group flex max-w-[90%] items-start gap-2">
      <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg border border-line bg-elev text-xs font-semibold text-accent">
        C
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] text-fg-faint">
          <span>claude · {formatAgo(turn.at, Date.now())}</span>
          <AttributionChips attribution={turn.attribution} />
          {isRunning && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-semibold text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
              running
            </span>
          )}
          {turn.outcome && <span className="font-mono text-[10.5px] font-semibold text-sage">{turn.outcome}</span>}
          {onQuote && presentation === 'text' && (
            <button
              type="button"
              onClick={() => onQuote(bodyText)}
              data-testid="chat-turn-quote"
              title="Quote this message in your reply"
              aria-label="Quote this message"
              className="opacity-0 hover:text-accent group-hover:opacity-100"
            >
              Quote
            </button>
          )}
        </div>
        {toolStripVariant === 'hidden' ? null : toolStripVariant === 'collapsible' ? (
          <CollapsibleToolStrip items={turn.toolUses} running={presentation === 'working'} />
        ) : (
          <ToolUseTraceStrip items={turn.toolUses} running={presentation === 'working'} />
        )}
        {toolStripVariant !== 'hidden' && <DiffCards items={turn.toolUses} />}
        {presentation === 'working' ? (
          <div className={`border border-line bg-elev px-3 py-2 text-sm text-fg-dim ${bubbleCorners}`}>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              working…
            </span>
          </div>
        ) : presentation === 'placeholder' ? (
          <div className={`border border-line bg-elev px-3 py-2 text-sm italic text-fg-dim ${bubbleCorners}`}>
            (no textual reply — see tool activity above)
          </div>
        ) : (
          <>
            <div
              ref={bodyRef}
              className={`prose-chat border px-3 py-2 text-sm leading-relaxed ${bubbleTone} ${bubbleCorners} ${isPlan ? 'prose-chat--plan' : ''}`}
              onClick={(e) => { void handleChatLinkClick(e, cwd) }}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: shownHtml }}
            />
            {(clamped.truncated || bodyExpanded) && clampBodyChars !== null && (
              <button
                type="button"
                onClick={() => setBodyExpanded((v) => !v)}
                data-testid="chat-turn-expand-body"
                className="mt-1 font-mono text-[10.5px] font-semibold text-fg-faint hover:text-accent"
              >
                {bodyExpanded ? 'Show less' : `Show full message (+${clamped.hiddenChars} chars)`}
              </button>
            )}
            {urls.map((url) => (
              <UrlCallout key={url} url={url} />
            ))}
            {filePaths.map((path) => (
              <FileCallout key={path} path={path} cwd={cwd} inlinePreview={inlineFilePreview} />
            ))}
          </>
        )}
        {presentation === 'text' && <TurnRawFooter turnRef={turn.ref} copyText={turn.text} testId="chat-turn-assistant-footer" />}
      </div>
    </div>
  )
}

// Historical turns (chat.ts's turns array) are appended immutably — earlier
// elements keep their object identity across a re-render that only appends
// one more — so a plain shallow-prop memo lets an unrelated Turn instance
// bail out of re-rendering entirely when its own turn/props didn't change.
// This is safe for both invariants above: a question/notice turn is never
// specially suppressed by this memo (it only skips re-render when the
// rendered output would be byte-identical anyway), and EpicDetail's in-flight
// bubble passes a brand-new `turn` object literal every render (its `text`
// mutates as the stream grows), so it never satisfies the shallow-equal
// check and keeps updating live while a run is in flight.
export const Turn = memo(TurnComponent)
