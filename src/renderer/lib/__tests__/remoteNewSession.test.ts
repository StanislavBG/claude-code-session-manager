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

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      chat: { onExternalNewSession: (h: typeof fire) => ((fire = h), unsub) },
      agents: { listPersonas: async () => [{ name: 'dev-lead', description: 'builds' }] },
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
})
