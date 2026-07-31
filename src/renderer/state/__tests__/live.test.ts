import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * live.ts's subscribe/unsubscribe is ref-counted so two mounted consumers
 * (e.g. two visible workbench panels reading the same tab's live state,
 * possible since link 3 lets dockview keep multiple panels mounted at
 * once) can share one underlying transcripts subscription without either
 * one's unmount tearing it down under the other. window.api is mocked
 * here since vitest runs this suite in a node environment.
 */

function installWindowApiMock() {
  const onEvent = vi.fn().mockReturnValue(vi.fn())
  const subscribe = vi.fn().mockResolvedValue({ ok: true, path: '/tmp/fake/transcript.jsonl' })
  const buffer = vi.fn().mockResolvedValue([])
  const unsubscribe = vi.fn()
  const api = {
    transcripts: { onEvent, subscribe, buffer, unsubscribe },
  }
  vi.stubGlobal('window', { api })
  return { api, onEvent, subscribe, buffer, unsubscribe }
}

describe('live.ts subscribe/unsubscribe refcounting', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('keeps the tab subscribed while a second consumer is still attached', async () => {
    const { subscribe: apiSubscribe, unsubscribe: apiUnsubscribe } = installWindowApiMock()
    const { useLive } = await import('../live')

    useLive.getState().subscribe('tab-1', '/proj', 'sess-1')
    useLive.getState().subscribe('tab-1', '/proj', 'sess-1')

    expect(useLive.getState().refs['tab-1']).toBe(2)
    expect(useLive.getState().tabs['tab-1']).toBeDefined()
    // Only the first subscribe wires up the underlying IPC subscription.
    expect(apiSubscribe).toHaveBeenCalledTimes(1)

    useLive.getState().unsubscribe('tab-1')

    expect(useLive.getState().refs['tab-1']).toBe(1)
    expect(useLive.getState().tabs['tab-1']).toBeDefined()
    expect(apiUnsubscribe).not.toHaveBeenCalled()

    useLive.getState().unsubscribe('tab-1')

    expect(useLive.getState().refs['tab-1']).toBeUndefined()
    expect(useLive.getState().tabs['tab-1']).toBeUndefined()
    expect(apiUnsubscribe).toHaveBeenCalledWith('tab-1')
  })

  it('unsubscribe on an untracked tabId is a no-op', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')

    expect(() => useLive.getState().unsubscribe('never-subscribed')).not.toThrow()
    expect(useLive.getState().refs['never-subscribed']).toBeUndefined()
  })
})
