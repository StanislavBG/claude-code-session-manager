import { beforeEach, describe, expect, it, vi } from 'vitest'

const launchSession = vi.fn()
const toastError = vi.fn()
vi.mock('../launchSession', () => ({ launchSession: (i: unknown) => launchSession(i) }))
vi.mock('../../state/toast', () => ({ toast: { error: (m: string) => toastError(m) } }))

import { registerRemoteNewSession } from '../remoteNewSession'

const payload: { cwd: string; agentName: string; tag: string; title: string; prompt: string; macroId?: string } = {
  cwd: '/p', agentName: 'dev-lead', tag: 'feature', title: 'T', prompt: 'do it',
}
let fire: (e: typeof payload) => Promise<void>
const unsub = vi.fn()
const logWrite = vi.fn()
const macrosList = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  macrosList.mockResolvedValue([])
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      chat: { onExternalNewSession: (h: typeof fire) => ((fire = h), unsub) },
      agents: { listPersonas: async () => [{ name: 'dev-lead', description: 'builds' }] },
      macros: { list: macrosList },
      logs: { write: logWrite },
    },
  }
})

describe('registerRemoteNewSession', () => {
  it('maps the payload onto launchSession', async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    expect(registerRemoteNewSession()).toBe(unsub)
    await fire(payload)
    expect(launchSession).toHaveBeenCalledWith({
      cwd: '/p',
      agentName: 'dev-lead',
      tag: 'feature',
      title: 'T',
      goal: 'do it',
      agentDescription: 'builds',
      source: 'WebRemote dev-lead',
    })
  })

  it('forwards macroId only when present', async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    registerRemoteNewSession()
    await fire({ ...payload, macroId: 'm1' })
    expect(launchSession).toHaveBeenLastCalledWith(expect.objectContaining({ macroId: 'm1' }))
    await fire(payload)
    expect(launchSession.mock.calls[1][0]).not.toHaveProperty('macroId')
  })

  it('toasts and logs on failure without throwing', async () => {
    launchSession.mockRejectedValue(new Error('boom'))
    registerRemoteNewSession()
    await expect(fire(payload)).resolves.toBeUndefined()
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^Phone session start failed:/))
    expect(logWrite).toHaveBeenCalledWith('webRemote', 'warn', expect.any(String))
  })

  it("routes a job macro through launchSession run 'job' with the extra instructions", async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    macrosList.mockResolvedValue([{ id: 'm1', job: { estimateMinutes: 5, artifactPaths: [] } }])
    registerRemoteNewSession()
    await fire({ ...payload, macroId: 'm1', prompt: 'do it\n\nAdditional instructions: more\n\nAdditional instructions: again' })
    expect(launchSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ macroId: 'm1', run: 'job', extraInstructions: 'more\n\nAdditional instructions: again' }),
    )
    await fire({ ...payload, macroId: 'm1' })
    const last = launchSession.mock.calls[1][0]
    expect(last.run).toBe('job')
    expect(last).not.toHaveProperty('extraInstructions')
  })

  it('a macro without job gets no run field', async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    macrosList.mockResolvedValue([{ id: 'm1' }])
    registerRemoteNewSession()
    await fire({ ...payload, macroId: 'm1' })
    expect(launchSession.mock.calls[0][0]).not.toHaveProperty('run')
  })
})
