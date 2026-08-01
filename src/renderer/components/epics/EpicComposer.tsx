import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChat, dispatchPromptSessionToPrd } from '../../state/chat'
import type { PromptSession } from '../../state/promptSessions'
import { epicDisplayStatus, type EpicSnapshots } from '../../lib/epicDerive'
import { EpicKindTag, epicStatusDotClass } from './epic-primitives'
import { AttachTray, useAttachments, type AttachmentItem } from './attachments'
import type { TicketTag } from '../../lib/ticketDisplay'
import { toast } from '../../state/toast'
import { useVoice, selectCanRecord } from '../../state/voice'
import { copyFor } from '../../lib/voiceCopy'

type ComposerAction = 'chat' | 'dispatch'

function defaultAction(tag: PromptSession['tag']): ComposerAction {
  return tag === 'discussion' ? 'chat' : 'dispatch'
}

/** Tag passed to dispatchPromptSessionToPrd when the "Dispatch as PRD" action
 *  is used — the Epic's own feature/bug tag, or 'feature' as a fallback when
 *  a discussion-tagged Epic's message is overridden to dispatch. */
function dispatchTag(tag: PromptSession['tag']): TicketTag {
  return tag === 'bug' ? 'bug' : 'feature'
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Resolves each attachment to an absolute path — real drag-drop/file-picker
 * paths pass through, pasted-clipboard images (no real path) are saved first
 * into the Epic's own prompt-sessions/attachments dir via the existing
 * browser.saveBinary IPC (already allowlisted under the cwd's
 * session-manager-operations write boundary).
 */
async function resolveAttachmentPaths(items: AttachmentItem[], cwd: string): Promise<string[]> {
  const paths: string[] = []
  for (const item of items) {
    if (item.hasRealPath) {
      paths.push(item.path)
      continue
    }
    try {
      const destPath = `${cwd}/session-manager-operations/prompt-sessions/attachments/${item.id}-${item.name}`
      const base64 = await fileToBase64(item.file)
      const res = await window.api.browser.saveBinary(destPath, base64)
      if (res.ok) {
        paths.push(destPath)
      } else {
        toast.error(`Failed to save attachment "${item.name}": ${res.error ?? 'unknown error'}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to save attachment "${item.name}": ${msg}`)
    }
  }
  return paths
}

/** An Epic that's already completed/archived shows no composer — its
 *  claudeSessionId is dead. Parent surfaces should gate on this instead of
 *  mounting EpicComposer at all. */
export function canCompose(epic: PromptSession): boolean {
  return epic.status !== 'completed'
}

interface Props {
  epic: PromptSession
  snapshots: EpicSnapshots
  onSent?: () => void
}

/**
 * Epic-scoped composer — replaces the composer embedded in the retired
 * PromptSessionConversation.tsx (PRDs 827/829). Preserves its dispatch mechanism exactly:
 * Chat -> useChat().send, Dispatch -> dispatchPromptSessionToPrd. Design:
 * session-manager-operations/design-mocks/epics/DESIGN_SPEC.md §"Composer".
 */
export function EpicComposer({ epic, snapshots, onSent }: Props) {
  const status = epicDisplayStatus(epic.id, snapshots)
  const running = status === 'running' || status === 'queued'

  const [text, setText] = useState('')
  const [action, setAction] = useState<ComposerAction>(defaultAction(epic.tag))
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

  // Composer state (text, attachments, action override) is scoped to the
  // Epic being iterated on — switching Epics must not leak a draft across.
  useEffect(() => {
    setText('')
    att.clear()
    setAction(defaultAction(epic.tag))
    setDictating(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    el.style.height = `${Math.min(180, Math.max(58, el.scrollHeight + chrome))}px`
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
      if (action === 'chat') {
        send({ tabId: epic.id, sessionId: epic.claudeSessionId, cwd: epic.cwd, prompt })
      } else {
        await dispatchPromptSessionToPrd(epic.id, epic.cwd, prompt, dispatchTag(epic.tag))
      }
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
      className={`border-t px-[22px] pb-3 pt-2 ${dragOver ? 'border-accent bg-accent/5' : 'border-rule bg-bg'}`}
    >
      <div className="mb-1.5 flex items-center gap-2" data-testid="epic-composer-context">
        <span className="font-mono text-[10.5px] text-fg-faint">iterating in</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-fg">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${epicStatusDotClass(status)}`} aria-hidden="true" />
          <span className="truncate">{epic.goalText}</span>
        </span>
        <EpicKindTag kind={epic.tag} small />
        {dragOver && (
          <span className="ml-auto font-mono text-[10.5px] font-semibold text-accent" data-testid="epic-composer-drop-hint">
            drop to attach
          </span>
        )}
      </div>

      <div className="mb-2 flex items-center gap-1 rounded-lg border border-line bg-bg-hi p-0.5" data-testid="epic-composer-action-toggle">
        <button
          type="button"
          onClick={() => setAction('chat')}
          data-testid="epic-composer-action-chat"
          aria-pressed={action === 'chat'}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${action === 'chat' ? 'bg-bg text-fg shadow-sm' : 'text-fg-faint hover:text-fg-dim'}`}
        >
          Chat
        </button>
        <button
          type="button"
          onClick={() => setAction('dispatch')}
          data-testid="epic-composer-action-dispatch"
          aria-pressed={action === 'dispatch'}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${action === 'dispatch' ? 'bg-bg text-fg shadow-sm' : 'text-fg-faint hover:text-fg-dim'}`}
        >
          Dispatch as PRD
        </button>
      </div>

      <AttachTray att={att} testId="epic-composer-attach-tray" />

      <div className="mt-2 flex items-end gap-2">
        <div
          className="flex h-[58px] shrink-0 items-center overflow-hidden rounded-[10px] border border-line bg-bg-hi"
          data-testid="epic-composer-input-tools"
        >
          <button
            type="button"
            data-testid="epic-composer-mic"
            onClick={onMicClick}
            disabled={voiceGate.reason === 'unsupported'}
            aria-pressed={dictating}
            aria-label={micLabel}
            title={micLabel}
            className={`grid h-full w-11 place-items-center ${
              dictating ? 'text-red-400' : isRecording ? 'text-fg-faint' : 'text-accent hover:text-accent/80'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="1" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="17" x2="12" y2="21" />
              <line x1="8" y1="21" x2="16" y2="21" />
            </svg>
          </button>
        </div>
        <textarea
          ref={textareaRef}
          data-testid="epic-composer-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={
            running
              ? 'Running… send to queue a follow-up in this Epic'
              : `Add to "${epic.goalText}" — Enter to send, ⌘V to attach a screenshot`
          }
          className="min-h-[58px] max-h-[180px] flex-1 resize-none overflow-y-auto rounded-[10px] border border-line bg-bg-hi px-3 py-2.5 text-[13px] leading-relaxed text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
        />
        {running && (
          <button
            type="button"
            data-testid="epic-composer-cancel"
            onClick={() => window.api.chat.cancel(epic.id)}
            className="h-[58px] shrink-0 px-1 text-[12.5px] font-semibold text-delta-bad hover:text-delta-bad/80"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          data-testid="epic-composer-send"
          onClick={() => void submit()}
          disabled={!canSend || sending}
          className={`h-[58px] shrink-0 rounded-[10px] px-5 text-[13px] font-semibold ${
            canSend && !sending ? 'bg-accent text-white hover:bg-accent/90' : 'bg-bg-hi text-fg-faint'
          }`}
        >
          {running ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  )
}
