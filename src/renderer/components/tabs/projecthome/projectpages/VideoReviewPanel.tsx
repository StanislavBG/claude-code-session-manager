/**
 * Project Home ▸ Video's human review step for project Video tools: one `Waiting for your OK` card
 * per review whose status is 'waiting' (`window.api.projectPages.reviewList`), with the saved
 * material's text (plain text — never HTML) and images (loaded via `smfileUrl`, as VideoPlayer
 * loads videos), and Approve / Ask for changes buttons calling the desktop-only
 * `projectPages.reviewDecide`. Ask for changes needs a non-blank note (at most 2000 chars).
 *
 * The list loads on mount and whenever `reloadKey` changes (VideosPane derives it from the tools'
 * job statuses) — no polling of its own — and after every successful decision. Every loaded list
 * is reported through `onReviews` so VideosPane can badge tool entries and regenerate them.
 * A failed load or decision shows an error toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { smfileUrl } from '../../../../state/editor'
import { useToast } from '../../../../state/toast'
import type { VideoReview } from '../../../../../preload/api'

/** reviewDecide's note cap. */
export const REVIEW_NOTE_MAX = 2000

const BUTTON_CLASS =
  'inline-flex h-8 flex-none items-center justify-center rounded-lg border border-rule-structural bg-bg-hi px-3 text-[12.5px] font-semibold text-fg cursor-pointer enabled:hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed'

const APPROVE_CLASS =
  'inline-flex h-8 flex-none items-center justify-center rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-bg-hi cursor-pointer enabled:hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ReviewCard({
  review,
  busy,
  onDecide,
}: {
  review: VideoReview
  busy: boolean
  onDecide: (entryId: string, decision: 'approve' | 'changes', note?: string) => void
}) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const material = review.material
  const blank = note.trim() === ''
  return (
    <section
      data-testid="video-review-card"
      data-entry={review.entryId}
      aria-label={`Waiting for your OK: ${review.entryId}`}
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-accent bg-bg-hi px-4 py-3.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[14px] font-semibold text-fg">Waiting for your OK</h3>
        <span data-col="entry" className="truncate font-mono text-[10.5px] text-fg-faint">
          {review.entryId}
        </span>
      </div>
      {material && material.text !== '' && (
        <p data-testid="video-review-text" className="m-0 whitespace-pre-wrap break-words text-[13px] text-fg">
          {material.text}
        </p>
      )}
      {material && material.images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {material.images.map((img) => (
            <img
              key={img.path}
              data-testid="video-review-image"
              src={smfileUrl(img.path)}
              alt={img.name}
              className="max-h-[220px] max-w-full rounded-md border border-rule-structural object-contain"
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="video-review-approve"
          disabled={busy}
          onClick={() => onDecide(review.entryId, 'approve')}
          className={APPROVE_CLASS}
        >
          Approve
        </button>
        <button
          type="button"
          data-testid="video-review-changes"
          disabled={busy}
          onClick={() => setNoteOpen(true)}
          className={BUTTON_CLASS}
        >
          Ask for changes
        </button>
      </div>
      {noteOpen && (
        <div className="flex flex-col gap-2">
          <textarea
            data-testid="video-review-note"
            aria-label="What should change"
            required
            maxLength={REVIEW_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, REVIEW_NOTE_MAX))}
            placeholder="What should change?"
            className="min-h-[70px] w-full rounded-lg border border-rule-structural bg-bg px-2.5 py-2 text-[13px] text-fg"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="video-review-send"
              disabled={busy || blank}
              onClick={() => onDecide(review.entryId, 'changes', note.trim())}
              className={BUTTON_CLASS}
            >
              Send changes
            </button>
            <button
              type="button"
              data-testid="video-review-cancel"
              disabled={busy}
              onClick={() => {
                setNoteOpen(false)
                setNote('')
              }}
              className={BUTTON_CLASS}
            >
              Cancel
            </button>
            <span className="font-mono text-[10.5px] text-fg-faint">{`${note.length}/${REVIEW_NOTE_MAX}`}</span>
          </div>
        </div>
      )}
    </section>
  )
}

export interface VideoReviewPanelProps {
  cwd?: string | null
  /** Changes whenever a tool's job status changes; each change reloads the list. */
  reloadKey?: string
  /** Every loaded list (all statuses), for VideosPane's badges and tool Regenerate. */
  onReviews?: (reviews: VideoReview[]) => void
}

export function VideoReviewPanel({ cwd, reloadKey, onReviews }: VideoReviewPanelProps) {
  const showToast = useToast((s) => s.show)
  const [reviews, setReviews] = useState<VideoReview[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const onReviewsRef = useRef(onReviews)
  onReviewsRef.current = onReviews
  // Drops a slower, older load that lands after a newer one.
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    if (!cwd) {
      setReviews([])
      onReviewsRef.current?.([])
      return
    }
    try {
      const list = await window.api.projectPages.reviewList({ cwd })
      if (seq !== loadSeq.current) return
      const all = Array.isArray(list) ? list : []
      setReviews(all)
      onReviewsRef.current?.(all)
    } catch (err) {
      if (seq === loadSeq.current) showToast('error', `Could not load video reviews: ${errorText(err)}`)
    }
  }, [cwd, showToast])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const decide = async (entryId: string, decision: 'approve' | 'changes', note?: string) => {
    if (!cwd || busyId !== null) return
    setBusyId(entryId)
    try {
      const res = await window.api.projectPages.reviewDecide(
        decision === 'changes' ? { cwd, entryId, decision, note } : { cwd, entryId, decision },
      )
      if (res && res.ok) {
        await load()
      } else {
        showToast('error', res && !res.ok ? res.error : 'Review decision failed')
      }
    } catch (err) {
      showToast('error', errorText(err))
    } finally {
      setBusyId(null)
    }
  }

  const waiting = reviews.filter((r) => r.status === 'waiting')
  if (waiting.length === 0) return null
  return (
    <div data-testid="video-review-panel" className="flex flex-none flex-col gap-2.5">
      {waiting.map((r) => (
        <ReviewCard key={r.entryId} review={r} busy={busyId !== null} onDecide={(id, d, n) => void decide(id, d, n)} />
      ))}
    </div>
  )
}
