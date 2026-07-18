import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * loadAgent() must surface a fetch error via toast — previously it only
 * stashed the message into `errorByAgent`, which nothing in the UI ever
 * read, so a failed list() silently showed an empty list.
 */

function installWindowApiMock(listResult: { entries: unknown[]; error: string | null }) {
  const api = {
    agentMemory: {
      list: vi.fn().mockResolvedValue(listResult),
    },
  }
  vi.stubGlobal('window', { api })
  return api
}

describe('agentMemory.ts useAgentMemory.loadAgent()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('toasts on a failed load instead of failing silently', async () => {
    installWindowApiMock({ entries: [], error: 'boom' })
    const { useAgentMemory } = await import('../agentMemory')
    const { toast } = await import('../toast')
    const spy = vi.spyOn(toast, 'error')

    await useAgentMemory.getState().loadAgent('some-agent')

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })

  it('does not toast on a successful load', async () => {
    installWindowApiMock({ entries: [], error: null })
    const { useAgentMemory } = await import('../agentMemory')
    const { toast } = await import('../toast')
    const spy = vi.spyOn(toast, 'error')

    await useAgentMemory.getState().loadAgent('some-agent')

    expect(spy).not.toHaveBeenCalled()
  })
})
