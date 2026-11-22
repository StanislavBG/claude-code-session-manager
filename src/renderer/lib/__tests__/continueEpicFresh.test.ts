import { beforeEach, describe, expect, it, vi } from 'vitest'

const launchSession = vi.fn()
const emitAuditEvent = vi.fn()
const state: { sessions: Record<string, unknown>; events: Record<string, unknown[]> } = { sessions: {}, events: {} }

vi.mock('../../state/promptSessions', () => ({
  usePromptSessions: { getState: () => state },
  emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a),
}))
vi.mock('../launchSession', () => ({
  launchSession: (input: unknown) => launchSession(input),
}))

import { continueEpicFresh } from '../continueEpicFresh'
import { buildEpicHandoff } from '../epicHandoff'

const read = vi.fn()

const epic = {
  id: 'old-1',
  cwd: '/p',
  goalText: 'My title\n\nThe goal\n\nwith more',
  claudeSessionId: 'c-old',
  status: 'active',
  createdAt: '2026-11-01T00:00:00Z',
  completedAt: null,
  tag: 'feature',
  agentType: 'architect',
  model: 'opus',
  effort: 'high',
  developLoop: false,
  agentCli: 'codex',
  agentCliModel: 'gpt-x',
  packs: ['pack-a'],
}

const events = [
  { id: 'e1', prdSlug: 'a', validation: 'verified', outcome: 'completed' },
  { id: 'e2', prdSlug: 'b', validation: 'refuted', outcome: 'completed' },
]

beforeEach(() => {
  vi.clearAllMocks()
  state.sessions = { 'old-1': epic }
  state.events = { 'old-1': events }
  ;(globalThis as unknown as { window: unknown }).window = { api: { promptSessionTranscript: { read } } }
  read.mockResolvedValue({
    turns: [
      { v: 1, epicId: 'old-1', eventId: null, role: 'assistant', at: 't1', text: 'first answer' },
      { v: 1, epicId: 'old-1', eventId: null, role: 'assistant', at: 't2', text: 'last answer' },
      { v: 1, epicId: 'old-1', eventId: null, role: 'user', at: 't3', text: 'a later question' },
    ],
  })
  launchSession.mockResolvedValue({ epicId: 'new-1', claudeSessionId: 'c-new' })
})

describe('continueEpicFresh', () => {
  it('launches with the old Epic fields and returns the new id', async () => {
    const id = await continueEpicFresh('old-1', 'continue-btn')
    expect(id).toBe('new-1')
    expect(read).toHaveBeenCalledWith('/p', 'old-1')
    expect(launchSession).toHaveBeenCalledTimes(1)
    const input = launchSession.mock.calls[0][0]
    expect(input).toMatchObject({
      cwd: '/p',
      title: 'My title',
      goal: 'The goal\n\nwith more',
      tag: 'feature',
      agentName: 'architect',
      model: 'opus',
      effort: 'high',
      packs: ['pack-a'],
      agentCli: 'codex',
      agentCliModel: 'gpt-x',
      developLoop: false,
      source: 'continue-btn',
    })
  })

  it('builds the handoff from the last assistant turn and the events', async () => {
    await continueEpicFresh('old-1', 'src')
    const { handoff: h } = launchSession.mock.calls[0][0]
    expect(h.fromEpicId).toBe('old-1')
    const handoff = h.text
    expect(handoff).toBe(
      buildEpicHandoff({
        fromEpicId: 'old-1',
        title: 'My title',
        lastAssistantText: 'last answer',
        outcomes: { verified: ['a'], refuted: ['b'], unvalidated: [] },
      }),
    )
    expect(handoff).toContain('last answer')
    expect(handoff).not.toContain('first answer')
    expect(handoff).toContain('1 verified, 1 refuted')
  })

  it('still launches when the transcript read fails, saying no answer was found', async () => {
    read.mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = await continueEpicFresh('old-1', 'src')
    expect(id).toBe('new-1')
    expect(launchSession.mock.calls[0][0].handoff.text).toContain('No earlier answer was found.')
    warn.mockRestore()
  })

  it('records the epic_continue audit event', async () => {
    await continueEpicFresh('old-1', 'src')
    expect(emitAuditEvent).toHaveBeenCalledWith('epic_continue', {
      cwd: '/p',
      epicId: 'new-1',
      fromEpicId: 'old-1',
      source: 'src',
    })
  })

  it('uses the title as goal when goalText has no blank line', async () => {
    state.sessions = { 'old-1': { ...epic, goalText: 'Only a title' } }
    await continueEpicFresh('old-1', 'src')
    expect(launchSession.mock.calls[0][0]).toMatchObject({ title: 'Only a title', goal: 'Only a title' })
  })

  it('launches without an agent when the Epic has no agent saved', async () => {
    state.sessions = { 'old-1': { ...epic, agentType: undefined } }
    const id = await continueEpicFresh('old-1', 'src')
    expect(id).toBe('new-1')
    expect(launchSession).toHaveBeenCalledTimes(1)
    const input = launchSession.mock.calls[0][0]
    expect(input).not.toHaveProperty('agentName')
    expect(input).toMatchObject({
      cwd: '/p',
      title: 'My title',
      goal: 'The goal\n\nwith more',
      tag: 'feature',
      model: 'opus',
      effort: 'high',
      packs: ['pack-a'],
      agentCli: 'codex',
      agentCliModel: 'gpt-x',
      developLoop: false,
      source: 'src',
    })
    expect(input.handoff.fromEpicId).toBe('old-1')
  })

  it('throws in words when the Epic is not in the store', async () => {
    await expect(continueEpicFresh('missing', 'src')).rejects.toThrow(/no session with id "missing"/i)
    expect(launchSession).not.toHaveBeenCalled()
    expect(emitAuditEvent).not.toHaveBeenCalled()
  })
})
