import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('prdDeepLink', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  })

  it('stores the slug so a not-yet-mounted consumer can pick it up on mount', async () => {
    const { setPendingPrdSlug, takePendingPrdSlug } = await import('../prdDeepLink')
    setPendingPrdSlug('750-chat-queue-panel')
    expect(takePendingPrdSlug()).toBe('750-chat-queue-panel')
  })

  it('clears after being taken, so a stale slug is never replayed', async () => {
    const { setPendingPrdSlug, takePendingPrdSlug } = await import('../prdDeepLink')
    setPendingPrdSlug('750-chat-queue-panel')
    takePendingPrdSlug()
    expect(takePendingPrdSlug()).toBeNull()
  })

  it('also dispatches a live sm:select-prd CustomEvent for an already-mounted listener', async () => {
    const { setPendingPrdSlug } = await import('../prdDeepLink')
    setPendingPrdSlug('750-chat-queue-panel')
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sm:select-prd', detail: '750-chat-queue-panel' }),
    )
  })
})
