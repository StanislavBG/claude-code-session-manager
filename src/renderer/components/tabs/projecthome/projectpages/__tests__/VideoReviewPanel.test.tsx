// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { VideoReviewPanel, REVIEW_NOTE_MAX, type VideoReviewPanelProps } from '../VideoReviewPanel'
import { smfileUrl } from '../../../../../state/editor'
import { useToast } from '../../../../../state/toast'
import type { VideoReview } from '../../../../../../preload/api'

const reviewList = vi.fn()
const reviewDecide = vi.fn()

function review(entryId: string, status: VideoReview['status'], over: Partial<VideoReview> = {}): VideoReview {
  return {
    entryId,
    status,
    job: null,
    canRetry: false,
    dispatch: {
      entryId,
      macroId: 'burrow-episode',
      epicId: 'epic-1',
      slug: `slug-${entryId}`,
      stage: 'review',
      inputValues: { topic: 'Moles' },
      extraInstructions: '',
      dispatchedAt: '2026-11-22T10:00:00.000Z',
    },
    material: {
      entryId,
      text: '<b>Script</b>\nScene 1: moles dig.',
      images: [
        { name: 'frame-1.png', path: `/proj/reviews/${entryId}/frame 1.png` },
        { name: 'frame-2.png', path: `/proj/reviews/${entryId}/frame-2.png` },
      ],
      savedAt: '2026-11-22T10:05:00.000Z',
    },
    decision: null,
    ...over,
  }
}

const WAITING = review('moles-ep', 'waiting')

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  reviewList.mockReset().mockResolvedValue([WAITING])
  reviewDecide.mockReset().mockResolvedValue({ ok: true, slug: 's2', stage: 'final', decision: {} })
  ;(window as unknown as { api: unknown }).api = { projectPages: { reviewList, reviewDecide } }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })

async function mount(over: Partial<VideoReviewPanelProps> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<VideoReviewPanel cwd="/proj" {...over} />))
  await flush()
  return container
}
const rerender = async (over: Partial<VideoReviewPanelProps>) => {
  act(() => root!.render(<VideoReviewPanel cwd="/proj" {...over} />))
  await flush()
}

const tid = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const tids = (id: string) => Array.from(container!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const btn = (id: string) => tid(id) as HTMLButtonElement
const click = async (el: HTMLElement | null) => {
  act(() => el!.click())
  await flush()
}
function type(el: HTMLElement | null, value: string) {
  const field = el as HTMLTextAreaElement
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    set.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const toasts = () => (useToast.getState() as unknown as { toasts: { kind: string; message: string }[] }).toasts

describe('VideoReviewPanel', () => {
  it('shows a Waiting for your OK card with the text as plain text and each image via smfileUrl', async () => {
    await mount()
    expect(reviewList).toHaveBeenCalledWith({ cwd: '/proj' })
    const cards = tids('video-review-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].querySelector('h3')?.textContent).toBe('Waiting for your OK')
    const text = tid('video-review-text')!
    expect(text.textContent).toBe('<b>Script</b>\nScene 1: moles dig.')
    expect(text.querySelector('b')).toBeNull()
    expect(tids('video-review-image').map((i) => i.getAttribute('src'))).toEqual([
      smfileUrl('/proj/reviews/moles-ep/frame 1.png'),
      smfileUrl('/proj/reviews/moles-ep/frame-2.png'),
    ])
    expect(tid('video-review-approve')?.textContent).toBe('Approve')
    expect(tid('video-review-changes')?.textContent).toBe('Ask for changes')
  })

  it('Approve calls reviewDecide with approve and reloads the list', async () => {
    await mount()
    reviewList.mockResolvedValue([{ ...WAITING, status: 'approved' }])
    await click(tid('video-review-approve'))
    expect(reviewDecide).toHaveBeenCalledWith({ cwd: '/proj', entryId: 'moles-ep', decision: 'approve' })
    expect(reviewList).toHaveBeenCalledTimes(2)
    expect(tid('video-review-card')).toBeNull()
  })

  it('disables the buttons while a decision is in flight', async () => {
    let resolve: (v: unknown) => void = () => {}
    reviewDecide.mockReturnValue(new Promise((r) => (resolve = r)))
    await mount()
    await click(tid('video-review-approve'))
    expect(btn('video-review-approve').disabled).toBe(true)
    expect(btn('video-review-changes').disabled).toBe(true)
    await act(async () => {
      resolve({ ok: true, slug: 's', stage: 'final', decision: {} })
    })
    await flush()
    expect(btn('video-review-approve').disabled).toBe(false)
  })

  it('Ask for changes requires a note (capped at 2000 chars) and sends it with decision changes', async () => {
    await mount()
    expect(tid('video-review-note')).toBeNull()
    await click(tid('video-review-changes'))
    const note = tid('video-review-note') as HTMLTextAreaElement
    expect(note.maxLength).toBe(REVIEW_NOTE_MAX)
    expect(btn('video-review-send').disabled).toBe(true)
    type(note, '   ')
    expect(btn('video-review-send').disabled).toBe(true)
    await click(tid('video-review-send'))
    expect(reviewDecide).not.toHaveBeenCalled()
    type(note, 'x'.repeat(REVIEW_NOTE_MAX + 50))
    expect((tid('video-review-note') as HTMLTextAreaElement).value).toHaveLength(REVIEW_NOTE_MAX)
    type(note, 'Make the mole friendlier')
    await click(tid('video-review-send'))
    expect(reviewDecide).toHaveBeenCalledWith({
      cwd: '/proj',
      entryId: 'moles-ep',
      decision: 'changes',
      note: 'Make the mole friendlier',
    })
    expect(reviewList).toHaveBeenCalledTimes(2)
  })

  it('an { ok: false } reply shows an error toast and keeps the card', async () => {
    reviewDecide.mockResolvedValue({ ok: false, error: 'a decision is already in flight' })
    await mount()
    await click(tid('video-review-approve'))
    expect(toasts()).toEqual([expect.objectContaining({ kind: 'error', message: 'a decision is already in flight' })])
    expect(reviewList).toHaveBeenCalledTimes(1)
    expect(tid('video-review-card')).not.toBeNull()
  })

  it('a thrown decision shows an error toast', async () => {
    reviewDecide.mockRejectedValue(new Error('desktop only'))
    await mount()
    await click(tid('video-review-approve'))
    expect(toasts()).toEqual([expect.objectContaining({ kind: 'error', message: 'desktop only' })])
  })

  it('renders no card or buttons for reviews that are not waiting', async () => {
    reviewList.mockResolvedValue([
      review('a', 'building', { material: null }),
      review('b', 'approved'),
      review('c', 'changes-requested'),
      review('d', null),
    ])
    await mount()
    expect(tid('video-review-panel')).toBeNull()
    expect(tid('video-review-approve')).toBeNull()
    expect(tid('video-review-changes')).toBeNull()
  })

  it('reports every loaded review and reloads only when reloadKey changes (no polling)', async () => {
    vi.useFakeTimers()
    try {
      const onReviews = vi.fn()
      await mount({ reloadKey: 'a', onReviews })
      expect(onReviews).toHaveBeenCalledWith([WAITING])
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      expect(reviewList).toHaveBeenCalledTimes(1)
      await rerender({ reloadKey: 'a', onReviews })
      expect(reviewList).toHaveBeenCalledTimes(1)
      await rerender({ reloadKey: 'b', onReviews })
      expect(reviewList).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('without a cwd it never calls reviewList', async () => {
    await mount({ cwd: null })
    expect(reviewList).not.toHaveBeenCalled()
    expect(tid('video-review-panel')).toBeNull()
  })
})
