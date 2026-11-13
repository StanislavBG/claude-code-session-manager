// An Epic's Changes view: loads the Epic's diff (window.api.epicChanges.get),
// renders each section's files with DiffFileView, keeps line-comment drafts in
// useEpicReview, and sends every comment as ONE chat message through the same
// useChat send the Epic composer uses. Mounted by EpicDetail (sibling PRD).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiffFile, EpicChangeSection, EpicChanges } from '../../../preload/api'
import type { PromptSession } from '../../state/promptSessions'
import { useChat } from '../../state/chat'
import { useEpicReview, selectEpicComments, selectEpicNote } from '../../state/epicReview'
import { toast } from '../../state/toast'
import { composeReviewMessage, type ReviewComment, type ReviewSide } from '../../lib/reviewMessage'
import { DiffFileView, type DiffCommentAnchor } from './DiffFileView'
import { canCompose } from './EpicComposer'

interface Props {
  promptSession: PromptSession
  onSent?: () => void
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; sections: EpicChangeSection[]; truncated: boolean }

/** Files past this index (across all sections) start collapsed. */
const EXPANDED_FILE_LIMIT = 30
/** Files with more changed lines than this start collapsed. */
const LARGE_FILE_LINES = 400

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Every `side:line` a comment can anchor to in this file (mirrors DiffFileView's rowAnchor). */
function anchorKeys(file: DiffFile): Set<string> {
  const keys = new Set<string>()
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'del') {
        if (l.oldNo != null) keys.add(`old:${l.oldNo}`)
      } else if (l.newNo != null) {
        keys.add(`new:${l.newNo}`)
      }
    }
  }
  return keys
}

function sendHint(status: PromptSession['status']): string | null {
  if (status === 'completed') return 'Resume this session to send comments'
  if (status === 'proposed') return 'Approve this session to send comments'
  return null
}

function sideLabel(side: ReviewSide, start: number, end: number): string {
  const range = start === end ? `line ${end}` : `lines ${start}-${end}`
  return side === 'old' ? `old ${range}` : range
}

export function EpicChangesView({ promptSession, onSent }: Props) {
  const epicId = promptSession.id
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const comments = useEpicReview(selectEpicComments(epicId))
  const note = useEpicReview(selectEpicNote(epicId))
  const addComment = useEpicReview((s) => s.addComment)
  const updateComment = useEpicReview((s) => s.updateComment)
  const removeComment = useEpicReview((s) => s.removeComment)
  const setNote = useEpicReview((s) => s.setNote)
  const clear = useEpicReview((s) => s.clear)

  // Monotonic request token — a response is applied only if it is still the
  // latest request (covers Epic switches and overlapping Refresh clicks).
  const requestSeq = useRef(0)
  const { cwd } = promptSession

  const fetchChanges = useCallback(() => {
    const seq = ++requestSeq.current
    setLoad({ kind: 'loading' })
    const fail = (message: string) => {
      if (seq !== requestSeq.current) return
      setLoad({ kind: 'error', message })
      toast.error(`Could not load changes: ${message}`)
    }
    let pending: Promise<EpicChanges>
    try {
      pending = window.api.epicChanges.get({ cwd, epicId })
    } catch (err) {
      fail(errorMessage(err))
      return
    }
    pending.then(
      (res) => {
        if (seq !== requestSeq.current) return
        if (!res.ok) {
          fail(res.reason)
          return
        }
        setLoad({ kind: 'ready', sections: res.sections, truncated: res.truncated })
      },
      (err: unknown) => fail(errorMessage(err)),
    )
  }, [cwd, epicId])

  useEffect(() => {
    fetchChanges()
  }, [fetchChanges])

  // Invalidate any in-flight request on unmount.
  useEffect(
    () => () => {
      requestSeq.current += 1
    },
    [],
  )

  const sections = load.kind === 'ready' ? load.sections : null

  const summary = useMemo(() => {
    let files = 0
    let additions = 0
    let deletions = 0
    for (const s of sections ?? []) {
      for (const f of s.files) {
        files += 1
        additions += f.additions
        deletions += f.deletions
      }
    }
    return { files, additions, deletions }
  }, [sections])

  const outdated = useMemo(() => {
    if (!sections) return [] as ReviewComment[]
    const anchors = new Map<string, Set<string>>()
    for (const s of sections) {
      for (const f of s.files) anchors.set(`${s.key}\u0000${f.path}`, anchorKeys(f))
    }
    return comments.filter((c) => {
      const keys = anchors.get(`${c.sectionKey}\u0000${c.path}`)
      return !keys || !keys.has(`${c.side}:${c.endLine}`)
    })
  }, [sections, comments])

  const message = useMemo(() => composeReviewMessage({ comments, note }), [comments, note])
  const composable = canCompose(promptSession)
  const hint = composable ? null : sendHint(promptSession.status)
  const sendDisabled = message === '' || !composable

  const onSend = () => {
    if (sendDisabled) return
    const result = useChat.getState().send({
      tabId: promptSession.id,
      sessionId: promptSession.claudeSessionId,
      cwd: promptSession.cwd,
      prompt: message,
    })
    if (result.disposition === 'sent' || result.disposition === 'queued') {
      clear(epicId)
      onSent?.()
      return
    }
    toast.error(`Comments not sent (${result.reason}) — your drafts are kept.`)
  }

  let fileIndex = 0
  let body: React.ReactNode
  if (load.kind === 'loading') {
    body = (
      <div data-testid="epic-changes-loading" className="px-3 py-4 text-[12px] text-fg-faint">
        Loading changes…
      </div>
    )
  } else if (load.kind === 'error') {
    body = (
      <div data-testid="epic-changes-error" className="px-3 py-4 text-[12px] text-accent-dark">
        Could not load changes: {load.message}
      </div>
    )
  } else if (load.sections.length === 0) {
    body = (
      <div data-testid="epic-changes-empty" className="px-3 py-4 text-[12px] text-fg-faint">
        No changes recorded for this session yet.
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {load.truncated && (
          <div data-testid="epic-changes-truncated" className="rounded border border-line bg-bg-elev px-3 py-2 text-[12px] text-fg-dim">
            This diff was truncated — some files or lines are not shown.
          </div>
        )}
        {load.sections.map((section) => (
          <section key={section.key} data-testid="epic-changes-section" className="flex flex-col gap-2">
            <header className="flex items-center gap-2 text-[12px]">
              <span className="font-medium text-fg">{section.label}</span>
              {section.head && <span className="font-mono text-fg-faint">{section.head.slice(0, 8)}</span>}
              {section.live && (
                <span data-testid="epic-changes-live" className="rounded bg-sage/20 px-1.5 text-[11px] text-sage-dark">
                  live
                </span>
              )}
            </header>
            {section.error && (
              <div data-testid="epic-changes-section-error" className="text-[12px] text-accent-dark">
                {section.error}
              </div>
            )}
            {section.files.map((file) => {
              const idx = fileIndex++
              const fileComments = comments.filter((c) => c.sectionKey === section.key && c.path === file.path)
              return (
                <DiffFileView
                  key={`${section.key}\u0000${file.path}`}
                  file={file}
                  comments={fileComments}
                  defaultCollapsed={idx >= EXPANDED_FILE_LIMIT || file.additions + file.deletions > LARGE_FILE_LINES}
                  onAddComment={(anchor: DiffCommentAnchor, text: string) =>
                    addComment(epicId, {
                      ...anchor,
                      body: text,
                      sectionKey: section.key,
                      sectionLabel: section.label,
                      commit: section.head,
                    })
                  }
                  onUpdateComment={(id, text) => updateComment(epicId, id, text)}
                  onRemoveComment={(id) => removeComment(epicId, id)}
                />
              )
            })}
          </section>
        ))}
      </div>
    )
  }

  return (
    <div data-testid="epic-changes" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[12px]">
        <span data-testid="epic-changes-summary" className="text-fg-dim">
          {summary.files} {summary.files === 1 ? 'file' : 'files'}{' '}
          <span className="font-mono text-sage-dark">+{summary.additions}</span>{' '}
          <span className="font-mono text-accent-dark">-{summary.deletions}</span>
          {' · '}
          {comments.length} draft {comments.length === 1 ? 'comment' : 'comments'}
        </span>
        <button
          type="button"
          data-testid="epic-changes-refresh"
          onClick={fetchChanges}
          className="ml-auto rounded border border-line px-2 py-0.5 text-fg-dim hover:text-fg"
        >
          Refresh
        </button>
      </div>
      <div data-testid="epic-changes-scroll" className="min-h-0 flex-1 overflow-y-auto p-3">
        {outdated.length > 0 && (
          <div data-testid="epic-changes-outdated" className="mb-4 rounded border border-line bg-bg-elev p-2 text-[12px]">
            <div className="mb-1 font-medium text-fg">Comments on lines no longer in the diff</div>
            {outdated.map((c) => (
              <div key={c.id} data-testid={`epic-changes-outdated-${c.id}`} className="flex items-start gap-2 py-1">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-fg-faint">
                    {c.path} · {sideLabel(c.side, c.startLine, c.endLine)}
                  </div>
                  <div className="whitespace-pre-wrap text-fg">{c.body}</div>
                </div>
                <button
                  type="button"
                  data-testid={`epic-changes-outdated-delete-${c.id}`}
                  onClick={() => removeComment(epicId, c.id)}
                  className="text-fg-dim hover:text-accent"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
        {body}
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
        <textarea
          data-testid="epic-changes-note"
          rows={2}
          value={note}
          onChange={(e) => setNote(epicId, e.target.value)}
          placeholder="Overall note for the agent (optional)"
          className="w-full resize-y rounded border border-line bg-bg-hi p-2 text-[12px] text-fg"
        />
        <div className="flex items-center gap-2">
          {hint && (
            <span data-testid="epic-changes-send-hint" className="text-[12px] text-fg-faint">
              {hint}
            </span>
          )}
          <button
            type="button"
            data-testid="epic-changes-send"
            disabled={sendDisabled}
            onClick={onSend}
            className="ml-auto rounded bg-accent px-3 py-1 text-[12px] text-white disabled:opacity-50"
          >
            Send {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
          </button>
        </div>
      </div>
    </div>
  )
}
