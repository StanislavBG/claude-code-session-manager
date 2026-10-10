import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const createPromptSession = vi.fn()
const approveProposed = vi.fn()
const send = vi.fn()

vi.mock('../../state/promptSessions', () => ({
  usePromptSessions: { getState: () => ({ createPromptSession, approveProposed }) },
}))
vi.mock('../../state/chat', () => ({
  useChat: { getState: () => ({ send }) },
}))
vi.mock('../epicIntake', () => ({
  composeEpicIntake: vi.fn((f: unknown) => {
    calls.push('compose')
    return { goalText: 'GOAL', openingPrompt: 'OPEN', sections: [{ kind: 'goal', label: 'g', text: 't' }], f }
  }),
}))

import { launchSession } from '../launchSession'
import { composeEpicIntake } from '../epicIntake'

const input = {
  cwd: '/p',
  agentName: 'dev-lead',
  tag: 'feature' as never,
  title: 'T',
  goal: 'G',
  agentDescription: 'desc',
  source: 'src',
}

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  createPromptSession.mockImplementation(async () => {
    calls.push('create')
    return { id: 'e1', claudeSessionId: 'c1' }
  })
  approveProposed.mockImplementation(() => void calls.push('approve'))
  send.mockImplementation(() => void calls.push('send'))
})

describe('launchSession', () => {
  it('runs compose -> create -> approve -> send in order with the right args', async () => {
    const out = await launchSession(input)
    expect(calls).toEqual(['compose', 'create', 'approve', 'send'])
    expect(composeEpicIntake).toHaveBeenCalledWith({
      title: 'T', goal: 'G', tag: 'feature', agentName: 'dev-lead', agentDescription: 'desc',
    })
    expect(createPromptSession).toHaveBeenCalledWith(
      '/p', 'GOAL', 'feature', 'src', 'dev-lead', 'OPEN', [{ kind: 'goal', label: 'g', text: 't' }],
    )
    expect(approveProposed).toHaveBeenCalledWith('e1', 'src')
    expect(send).toHaveBeenCalledWith({ tabId: 'e1', sessionId: 'c1', cwd: '/p', prompt: 'OPEN' })
    expect(out).toEqual({ epicId: 'e1', claudeSessionId: 'c1' })
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
})
