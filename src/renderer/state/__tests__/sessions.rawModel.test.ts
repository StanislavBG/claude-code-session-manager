import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveStartupCommand } from '../sessions'

const resolveEpicModel = vi.fn()

beforeEach(() => {
  resolveEpicModel.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      agents: { resolveEpicModel },
      transcripts: { exists: vi.fn().mockResolvedValue(false) },
    },
  }
})

describe('raw tab model resolution', () => {
  it('uses the main resolver (settings model) when no override is given', async () => {
    resolveEpicModel.mockResolvedValue('claude-opus-5')
    const { startupCommand } = await resolveStartupCommand({ cwd: '/p', sessionId: 's1' }, true)
    expect(resolveEpicModel).toHaveBeenCalledWith({ cwd: '/p', claudeSessionId: expect.any(String) })
    expect(startupCommand).toContain("--model 'claude-opus-5'")
  })

  it('a per-launch override wins and skips the resolver', async () => {
    const { startupCommand } = await resolveStartupCommand({ cwd: '/p', sessionId: 's1' }, true, 'haiku')
    expect(resolveEpicModel).not.toHaveBeenCalled()
    expect(startupCommand).toContain("--model 'haiku'")
  })

  it('still pins --model when the IPC rejects', async () => {
    resolveEpicModel.mockRejectedValue(new Error('boom'))
    const { startupCommand } = await resolveStartupCommand({ cwd: '/p', sessionId: 's1' }, true)
    expect(startupCommand).toContain("--model 'sonnet'")
  })
})
