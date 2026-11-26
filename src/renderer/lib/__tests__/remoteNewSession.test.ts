import { beforeEach, describe, expect, it, vi } from 'vitest'

const launchSession = vi.fn()
const toastError = vi.fn()
vi.mock('../launchSession', () => ({ launchSession: (i: unknown) => launchSession(i) }))
vi.mock('../../state/toast', () => ({ toast: { error: (m: string) => toastError(m) } }))

import { registerRemoteNewSession } from '../remoteNewSession'

const payload: {
  cwd: string; agentName: string; tag: string; title: string; prompt: string; macroId?: string; externalRef?: string
  requestId?: string; via?: 'script'; startedBy?: { kind: 'script'; route: string }; effort?: string; reviewStage?: boolean
} = {
  cwd: '/p', agentName: 'dev-lead', tag: 'feature', title: 'T', prompt: 'do it',
}
let fire: (e: typeof payload) => Promise<void>
const unsub = vi.fn()
const logWrite = vi.fn()
const macrosList = vi.fn()
const reportResult = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  macrosList.mockResolvedValue([])
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      chat: { onExternalNewSession: (h: typeof fire) => ((fire = h), unsub), reportExternalNewSessionResult: reportResult },
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

  it('forwards externalRef only when it is a non-empty string', async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    registerRemoteNewSession()
    await fire({ ...payload, via: 'script', externalRef: 'ext-42' })
    expect(launchSession).toHaveBeenLastCalledWith(expect.objectContaining({ externalRef: 'ext-42' }))
    await fire({ ...payload, via: 'script' })
    expect(launchSession.mock.calls[1][0]).not.toHaveProperty('externalRef')
    await fire({ ...payload, via: 'script', externalRef: '' })
    expect(launchSession.mock.calls[2][0]).not.toHaveProperty('externalRef')
  })

  it('forwards startedBy only for a script press', async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    registerRemoteNewSession()
    const startedBy = { kind: 'script' as const, route: '/r' }
    await fire({ ...payload, via: 'script', startedBy })
    expect(launchSession).toHaveBeenLastCalledWith(expect.objectContaining({ startedBy }))
    await fire({ ...payload, startedBy })
    expect(launchSession.mock.calls[1][0]).not.toHaveProperty('startedBy')
  })

  it('toasts and logs on failure without throwing', async () => {
    launchSession.mockRejectedValue(new Error('boom'))
    registerRemoteNewSession()
    await expect(fire(payload)).resolves.toBeUndefined()
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^Phone session start failed:/))
    expect(logWrite).toHaveBeenCalledWith('webRemote', 'warn', expect.stringMatching(/^phone session start failed for /))
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

  it("starts a script payload with source 'Script <agent>', origin 'external', effort, macroId, and reports the epicId", async () => {
    launchSession.mockResolvedValue({ epicId: 'e7', claudeSessionId: 's' })
    registerRemoteNewSession()
    await fire({ ...payload, via: 'script', macroId: 'm1', effort: 'high', requestId: 'r1' })
    expect(launchSession).toHaveBeenCalledWith({
      cwd: '/p', agentName: 'dev-lead', tag: 'feature', title: 'T', goal: 'do it', agentDescription: 'builds',
      source: 'Script dev-lead', origin: 'external', macroId: 'm1', effort: 'high',
    })
    expect(reportResult).toHaveBeenCalledWith({ requestId: 'r1', ok: true, epicId: 'e7' })
  })

  it('a phone payload gets no origin or effort and no report without requestId', async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    registerRemoteNewSession()
    await fire({ ...payload, effort: '' })
    const arg = launchSession.mock.calls[0][0]
    expect(arg.source).toBe('WebRemote dev-lead')
    expect(arg).not.toHaveProperty('origin')
    expect(arg).not.toHaveProperty('effort')
    expect(reportResult).not.toHaveBeenCalled()
  })

  it('reports ok:false with the error when launchSession throws, keeping toast + log', async () => {
    launchSession.mockRejectedValue(new Error('boom'))
    registerRemoteNewSession()
    await fire({ ...payload, via: 'script', requestId: 'r2' })
    expect(reportResult).toHaveBeenCalledWith({ requestId: 'r2', ok: false, error: 'boom' })
    expect(toastError).toHaveBeenCalled()
    expect(logWrite).toHaveBeenCalledWith('webRemote', 'warn', expect.any(String))
  })

  it('truncates a long script failure report to 500 chars and words the toast + log for scripts', async () => {
    const long = 'x'.repeat(2000)
    launchSession.mockRejectedValue(new Error(long))
    registerRemoteNewSession()
    await fire({ ...payload, via: 'script', requestId: 'r3' })
    await Promise.resolve()
    expect(reportResult).toHaveBeenCalledTimes(1)
    const reported = reportResult.mock.calls[0][0]
    expect(reported).toEqual({ requestId: 'r3', ok: false, error: long.slice(0, 500) })
    expect(reported.error).toHaveLength(500)
    expect(toastError).toHaveBeenCalledWith(`Script session start failed: ${long}`)
    expect(toastError.mock.calls[0][0]).toMatch(/^Script session start failed/)
    expect(logWrite).toHaveBeenCalledWith('webRemote', 'warn', `script session start failed for dev-lead in /p: ${long}`)
  })

  it('a scripted job press with reviewStage forwards it and reports entryId/slug/stage', async () => {
    launchSession.mockResolvedValue({ epicId: 'e9', claudeSessionId: 's', entryId: 'v1', slug: 'demo-1', stage: 'review' })
    macrosList.mockResolvedValue([{ id: 'm1', job: { estimateMinutes: 5, artifactPaths: [] } }])
    registerRemoteNewSession()
    await fire({ ...payload, via: 'script', macroId: 'm1', requestId: 'r9', reviewStage: true })
    expect(launchSession).toHaveBeenLastCalledWith(expect.objectContaining({ run: 'job', reviewStage: true }))
    expect(reportResult).toHaveBeenCalledWith({ requestId: 'r9', ok: true, epicId: 'e9', entryId: 'v1', slug: 'demo-1', stage: 'review' })
  })

  it('a phone (non-script) job payload with reviewStage does not forward it', async () => {
    launchSession.mockResolvedValue({ epicId: 'e', claudeSessionId: 's' })
    macrosList.mockResolvedValue([{ id: 'm1', job: { estimateMinutes: 5, artifactPaths: [] } }])
    registerRemoteNewSession()
    await fire({ ...payload, macroId: 'm1', reviewStage: true })
    const arg = launchSession.mock.calls[0][0]
    expect(arg.run).toBe('job')
    expect(arg).not.toHaveProperty('reviewStage')
  })

  it('a scripted chat macro with reviewStage does not forward it and reports only epicId', async () => {
    launchSession.mockResolvedValue({ epicId: 'e3', claudeSessionId: 's' })
    macrosList.mockResolvedValue([{ id: 'm1' }])
    registerRemoteNewSession()
    await fire({ ...payload, via: 'script', macroId: 'm1', requestId: 'r4', reviewStage: true })
    expect(launchSession.mock.calls[0][0]).not.toHaveProperty('reviewStage')
    expect(reportResult).toHaveBeenCalledWith({ requestId: 'r4', ok: true, epicId: 'e3' })
  })
})
