import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChat } from '../../state/chat'
import type { PromptSession } from '../../state/promptSessions'
import { epicDisplayStatus, type EpicSnapshots } from '../../lib/epicDerive'
import { AttachButton, AttachTray, attachPastedFiles, resolveAttachmentPaths, useAttachments } from './attachments'
import { useVoice, selectCanRecord } from '../../state/voice'
import { copyFor } from '../../lib/voiceCopy'
import { takePendingEpicDraft } from '../../lib/epicDraftText'

/** Height of every control in the composer's single row — the textarea's
 *  collapsed height, the tools column, Cancel and Send. One constant so they
 *  can't drift apart. Was 58px alongside a separate dashed attach row above;
 *  the row is gone (see attachments.tsx's AttachButton) and a one-line prompt
 *  no longer reserves two lines, which is where the vertical space came from. */
const CONTROL_H = 44

/** An Epic that's already completed/archived shows no composer — its
 *  claudeSessionId is dead. Parent surfaces should gate on this instead of
 *  mounting EpicComposer at all. */
export function canCompose(epic: PromptSession): boolean {
  // 'proposed' Epics show EpicApprovalBar instead — they have not been
  // approved to spend anything yet, so there is nothing to compose into.
  return epic.status === 'active'
}

interface Props {
  epic: PromptSession
  snapshots: EpicSnapshots
  onSent?: () => void
  /** Quoted snippet from a turn's "Quote" button (ChatTranscriptTurn.tsx),
   *  owned by the shared parent (EpicsWorkspace) since it spans both the
   *  Discussion timeline (EpicDetail) and this composer, rendered as
   *  siblings. Purely a visual reply-context affordance — never prepended
   *  into the sent prompt text. */
  quote?: string
  onClearQuote?: () => void
}

/**
 * Epic-scoped composer — replaces the composer embedded in the retired
 * PromptSessionConversation.tsx (PRDs 827/829). Always routes through Chat
 * (useChat().send) — the agent creates PRDs itself as needed, so there is
 * no separate "Dispatch as PRD" action here.
 * Design: session-manager-operations/design-mocks/epics/DESIGN_SPEC.md §"Composer".
 */
export function EpicComposer({ epic, snapshots, onSent, quote, onClearQuote }: Props) {
  const status = epicDisplayStatus(epic.id, snapshots)
  const running = status === 'running' || status === 'queued'

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const att = useAttachments()
  const send = useChat((s) => s.send)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Dictation: appends into `text` via a sink, never auto-submits. `dictating`
  // tracks whether THIS composer owns the in-flight recording (vs. some other
  // mic consumer, e.g. a Terminal tab) so its button doesn't stop someone
  // else's session.
  const [dictating, setDictating] = useState(false)
  const isRecording = useVoice((s) => s.isRecording)
  const voiceGate = useVoice(useShallow(selectCanRecord))

  // Composer state (text, attachments) is scoped to the Epic being iterated
  // on — switching Epics must not leak a draft across.
  useEffect(() => {
    setText(takePendingEpicDraft(epic.id) ?? '')
    att.clear()
    setDictating(false)
  }, [epic.id])

  // Recognition can stop on its own (idle timeout, error) without this
  // composer calling stopRecording — drop ownership when that happens.
  useEffect(() => {
    if (!isRecording && dictating) setDictating(false)
  }, [isRecording, dictating])

  const onMicClick = () => {
    if (dictating) {
      useVoice.getState().stopRecording()
      return
    }
    if (isRecording || !voiceGate.canRecord) return
    setDictating(true)
    useVoice.getState().startRecording(epic.id, {
      sink: (transcript) => setText((prev) => (prev ? `${prev} ${transcript}` : transcript)),
    })
  }

  const micLabel = copyFor(voiceGate.reason, { isRecording: dictating })

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const chrome = el.offsetHeight - el.clientHeight
    el.style.height = `${Math.min(160, Math.max(CONTROL_H, el.scrollHeight + chrome))}px`
  }, [text])

  const canSend = Boolean(text.trim() || att.items.length)

  const submit = async () => {
    if (!canSend || sending) return
    const trimmed = text.trim()
    const attachmentsSnapshot = att.items
    setText('')
    att.clear()
    setSending(true)
    try {
      const referencePaths = await resolveAttachmentPaths(attachmentsSnapshot, epic.cwd)
      const referenceLines = referencePaths.map((p) => `Attached: ${p}`)
      const prompt = referenceLines.length ? `${trimmed}\n\n${referenceLines.join('\n')}` : trimmed
      send({ tabId: epic.id, sessionId: epic.claudeSessionId, cwd: epic.cwd, prompt })
      onClearQuote?.()
      onSent?.()
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) att.add(e.dataTransfer.files)
  }

  return (
    <div
      data-testid="epic-composer"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`border-t px-[22px] py-2 ${dragOver ? 'border-accent bg-accent/5' : 'border-rule bg-bg'}`}
    >
      <AttachTray att={att} testId="epic-composer-attach-tray" />

      {quote && (
        <div
          className="mb-2 flex items-start gap-2 rounded-md border-l-2 border-accent bg-bg-hi py-1.5 pl-2.5 pr-2"
          data-testid="epic-composer-quote-strip"
        >
          <p className="min-w-0 flex-1 line-clamp-2 text-[12.5px] leading-relaxed text-fg-dim">{quote}</p>
          <button
            type="button"
            onClick={() => onClearQuote?.()}
            data-testid="epic-composer-quote-clear"
            aria-label="Clear quoted text"
            className="shrink-0 text-fg-faint hover:text-fg"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div
          data-testid="epic-composer-input"
          className="relative flex-1 rounded-xl border border-line bg-bg-hi"
        >
          <textarea
            ref={textareaRef}
            data-testid="epic-composer-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => attachPastedFiles(e, att)}
            rows={1}
            placeholder="Queue a follow-up… ⌘V to attach a screenshot"
            className="min-h-[44px] max-h-[160px] w-full resize-none overflow-y-auto rounded-xl bg-transparent px-3 py-2.5 pr-[72px] text-[13px] leading-relaxed text-fg placeholder:text-fg-faint focus:outline-none"
          />
          <div className="absolute bottom-1.5 right-2 flex items-center gap-1.5">
            <button
              type="button"
              data-testid="epic-composer-mic"
              onClick={onMicClick}
              disabled={voiceGate.reason === 'unsupported'}
              aria-pressed={dictating}
              aria-label={micLabel}
              title={micLabel}
              className={`grid h-7 w-7 place-items-center rounded-md ${
                dictating ? 'text-red-400' : isRecording ? 'text-fg-faint' : 'text-fg-faint hover:text-fg'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="1" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <line x1="12" y1="17" x2="12" y2="21" />
                <line x1="8" y1="21" x2="16" y2="21" />
              </svg>
            </button>
            <AttachButton
              att={att}
              testId="epic-composer-attach"
              className="grid h-7 w-7 place-items-center rounded-md text-fg-faint hover:text-fg"
              size={14}
            />
          </div>
        </div>
        {running && (
          <button
            type="button"
            data-testid="epic-composer-cancel"
            onClick={() => window.api.chat.cancel(epic.id)}
            className="h-[44px] shrink-0 px-2 text-[13px] font-medium text-accent hover:text-accent/80"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          data-testid="epic-composer-send"
          onClick={() => void submit()}
          disabled={!canSend || sending}
          className={`h-[44px] shrink-0 rounded-xl px-5 text-[13px] font-semibold ${
            canSend && !sending ? 'bg-fg text-bg hover:bg-fg/90' : 'bg-bg-hi text-fg-faint'
          }`}
        >
          {running ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  )
}
