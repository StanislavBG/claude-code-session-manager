import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const createPromptSession = vi.fn()
const approveProposed = vi.fn()
const send = vi.fn()
const awaitApprovePersisted = vi.fn()

vi.mock('../../state/promptSessions', () => ({
  usePromptSessions: { getState: () => ({ createPromptSession, approveProposed }) },
  awaitApprovePersisted: (id: string) => awaitApprovePersisted(id),
}))
vi.mock('../../state/chat', () => ({
  useChat: { getState: () => ({ send }) },
}))
vi.mock('../epicIntake', () => ({
  composeEpicIntake: vi.fn((f: unknown) => {
    calls.push('compose')
    return { goalText: 'GOAL', openingPrompt: 'OPEN', sections: [{ kind: 'mission', part: 'goal', label: 'g', text: 't' }], f }
  }),
}))

import { launchSession } from '../launchSession'
import { composeEpicIntake } from '../epicIntake'
import { CONTEXT_INJECTIONS } from '../contextInjections'

const input = {
  cwd: '/p',
  agentName: 'dev-lead',
  tag: 'feature' as never,
  title: 'T',
  goal: 'G',
  agentDescription: 'desc',
  source: 'src',
}

const getPersonaBody = vi.fn()
const dispatchJob = vi.fn()

beforeEach(() => {
  ;(globalThis as unknown as { window: unknown }).window = { api: { agents: { getPersonaBody }, macros: { dispatchJob } } }
  getPersonaBody.mockResolvedValue(null)
  calls.length = 0
  vi.clearAllMocks()
  createPromptSession.mockImplementation(async () => {
    calls.push('create')
    return { id: 'e1', claudeSessionId: 'c1' }
  })
  approveProposed.mockImplementation(() => void calls.push('approve'))
  send.mockImplementation(() => void calls.push('send'))
  awaitApprovePersisted.mockResolvedValue(undefined)
})

describe('launchSession', () => {
  it('runs compose -> create -> approve -> send in order with the right args', async () => {
    const out = await launchSession(input)
    expect(calls).toEqual(['compose', 'create', 'approve', 'send'])
    expect(composeEpicIntake).toHaveBeenCalledWith({
      title: 'T', goal: 'G', tag: 'feature', agentName: 'dev-lead', agentDescription: 'desc',
      contextInjections: { 'general-behavior': true, 'delegate-implementation': true },
    })
    expect(createPromptSession).toHaveBeenCalledWith(
      '/p', 'GOAL', 'feature', 'src', 'dev-lead', 'OPEN', [{ kind: 'mission', part: 'goal', label: 'g', text: 't' }],
    )
    expect(approveProposed).toHaveBeenCalledWith('e1', 'src')
    expect(send).toHaveBeenCalledWith({ tabId: 'e1', sessionId: 'c1', cwd: '/p', prompt: 'OPEN' })
    expect(out).toEqual({ epicId: 'e1', claudeSessionId: 'c1' })
  })

  it('forwards macroId as the runtime argument only when set', async () => {
    await launchSession({ ...input, macroId: 'm9' })
    expect(createPromptSession.mock.calls[0][7]).toEqual({ macroId: 'm9' })
    createPromptSession.mockClear()
    await launchSession(input)
    expect(createPromptSession.mock.calls[0]).toHaveLength(7)
  })

  it('passes the persona body to composeEpicIntake when persona readable', async () => {
    getPersonaBody.mockResolvedValueOnce({ path: '/a/dev-lead.md', text: 'BODY' })
    await launchSession(input)
    expect(getPersonaBody).toHaveBeenCalledWith({ cwd: '/p', name: 'dev-lead' })
    expect(composeEpicIntake).toHaveBeenCalledWith(
      expect.objectContaining({ agentBody: 'BODY', agentPath: '/a/dev-lead.md' }),
    )
  })

  it('falls back when persona unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getPersonaBody.mockRejectedValueOnce(new Error('nope'))
    await expect(launchSession(input)).resolves.toEqual({ epicId: 'e1', claudeSessionId: 'c1' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(composeEpicIntake).toHaveBeenCalledWith({
      title: 'T', goal: 'G', tag: 'feature', agentName: 'dev-lead', agentDescription: 'desc',
      contextInjections: { 'general-behavior': true, 'delegate-implementation': true },
    })
    warn.mockRestore()
  })

  it.each([
    ['feature', true],
    ['discussion', false],
  ] as const)('%s launch: delegate-implementation injection=%s, general-behavior always', async (tag, delegate) => {
    const actual = await vi.importActual<typeof import('../epicIntake')>('../epicIntake')
    vi.mocked(composeEpicIntake).mockImplementationOnce(actual.composeEpicIntake)
    await launchSession({ ...input, tag: tag as never })
    const [, , , , , openingPrompt, sections] = createPromptSession.mock.calls[0]
    const texts = (sections as { text: string }[]).map((s) => s.text)
    const general = CONTEXT_INJECTIONS['general-behavior'].text
    const deleg = CONTEXT_INJECTIONS['delegate-implementation'].text
    expect(openingPrompt).toContain(general)
    expect(texts.some((t) => t.includes(general))).toBe(true)
    expect((openingPrompt as string).includes(deleg)).toBe(delegate)
    expect(texts.some((t) => t.includes(deleg))).toBe(delegate)
  })

  it.each(['cwd', 'agentName', 'title', 'goal'] as const)('throws on empty %s', async (key) => {
    await expect(launchSession({ ...input, [key]: '' })).rejects.toThrow(key)
    expect(createPromptSession).not.toHaveBeenCalled()
  })

  it('propagates createPromptSession errors without approving or sending', async () => {
    createPromptSession.mockRejectedValueOnce(new Error('boom'))
    await expect(launchSession(input)).rejects.toThrow('boom')
    expect(approveProposed).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("run 'job': mints + approves, dispatches the job, never sends a chat turn", async () => {
    dispatchJob.mockResolvedValue({ ok: true, slug: 's', epicId: 'e1' })
    const out = await launchSession({ ...input, macroId: 'm9', run: 'job', extraInstructions: 'x' })
    expect(calls).toEqual(['compose', 'create', 'approve'])
    expect(dispatchJob).toHaveBeenCalledWith({ cwd: '/p', macroId: 'm9', epicId: 'e1', extraInstructions: 'x' })
    expect(send).not.toHaveBeenCalled()
    expect(out).toEqual({ epicId: 'e1', claudeSessionId: 'c1' })
  })

  it("run 'job': an { ok: false } result throws its error text", async () => {
    dispatchJob.mockResolvedValue({ ok: false, error: 'already building' })
    const err = await launchSession({ ...input, macroId: 'm9', run: 'job' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('already building')
    expect((err as Error).message).toContain('build was not queued')
    expect(send).not.toHaveBeenCalled()
  })

  it("run 'job': waits for the approval to persist before dispatching", async () => {
    let release!: () => void
    awaitApprovePersisted.mockReturnValue(new Promise<void>((r) => { release = r }))
    dispatchJob.mockResolvedValue({ ok: true, slug: 's', epicId: 'e1' })
    const p = launchSession({ ...input, macroId: 'm9', run: 'job', extraInstructions: 'x' })
    await vi.waitFor(() => expect(awaitApprovePersisted).toHaveBeenCalledWith('e1'))
    await new Promise((r) => setTimeout(r, 10))
    expect(dispatchJob).not.toHaveBeenCalled()
    release()
    await p
    expect(dispatchJob).toHaveBeenCalledTimes(1)
    expect(dispatchJob).toHaveBeenCalledWith({ cwd: '/p', macroId: 'm9', epicId: 'e1', extraInstructions: 'x' })
  })

  it("run 'job': a failed approval persist skips dispatch and names the retry", async () => {
    awaitApprovePersisted.mockRejectedValue(new Error('disk full'))
    const err = await launchSession({ ...input, title: 'Competitor matrix', macroId: 'm9', run: 'job' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain('Competitor matrix')
    expect(msg).toContain('build was not queued')
    expect(msg).toContain('press it again')
    expect(dispatchJob).not.toHaveBeenCalled()
  })

  it('chat path never awaits the approval persist', async () => {
    await launchSession(input)
    expect(awaitApprovePersisted).not.toHaveBeenCalled()
  })

  it('approve false: mints only — no approve, no opening prompt, no job', async () => {
    const out = await launchSession({ ...input, approve: false })
    expect(calls).toEqual(['compose', 'create'])
    expect(approveProposed).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(dispatchJob).not.toHaveBeenCalled()
    expect(out).toEqual({ epicId: 'e1', claudeSessionId: 'c1' })
  })

  it('approve true (explicit) behaves like the default', async () => {
    await launchSession({ ...input, approve: true })
    expect(calls).toEqual(['compose', 'create', 'approve', 'send'])
  })
})
