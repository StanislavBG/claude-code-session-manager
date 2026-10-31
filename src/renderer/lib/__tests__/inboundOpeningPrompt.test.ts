import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PromptSession } from '../../state/promptSessions'
import { composeInboundOpening } from '../inboundOpeningPrompt'

function epic(over: Partial<PromptSession> = {}): PromptSession {
  return {
    id: 'e1',
    cwd: '/tmp/proj',
    goalText: 'Goal: t',
    claudeSessionId: 's1',
    status: 'proposed',
    createdAt: '',
    completedAt: null,
    tag: 'feature',
    agentType: 'architect',
    sections: [
      { kind: 'input', label: 'Input', text: 'INBOUND FEEDBACK' },
      { kind: 'goal', label: 'Goal', text: 'Goal: t\n\ndetails' },
      { kind: 'reference', label: 'Reference', text: 'Reference: /a/b', source: '/a/b' },
    ],
    ...over,
  } as PromptSession
}

describe('composeInboundOpening', () => {
  let listPersonas: ReturnType<typeof vi.fn>
  let getPersonaBody: ReturnType<typeof vi.fn>
  beforeEach(() => {
    listPersonas = vi.fn().mockResolvedValue([{ name: 'architect', description: 'plans work' }])
    getPersonaBody = vi.fn().mockResolvedValue({ path: '/p/architect.md', text: '---\nname: x\n---\nPERSONA RULES' })
    vi.stubGlobal('window', { api: { agents: { listPersonas, getPersonaBody } } })
  })

  it('emits actor, persona-body, injection, input, mission, goal, reference in order', async () => {
    const out = await composeInboundOpening(epic())
    expect(out).not.toBeNull()
    const kinds = out!.sections.map((s) => s.kind)
    const order = ['actor', 'persona-body', 'injection', 'input', 'mission', 'goal', 'reference']
    const idx = kinds.map((k) => order.indexOf(k))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    expect(kinds[0]).toBe('actor')
    expect(kinds).toContain('persona-body')
    expect(kinds).toContain('mission')
    expect(kinds[kinds.length - 1]).toBe('reference')
    expect(out!.openingPrompt).toContain('PERSONA RULES')
    expect(out!.openingPrompt).toContain('Goal: t\n\ndetails')
    expect(out!.openingPrompt).not.toContain('Goal: Goal:')
  })

  it('returns null with no stored sections', async () => {
    expect(await composeInboundOpening(epic({ sections: undefined }))).toBeNull()
    expect(await composeInboundOpening(epic({ sections: [] }))).toBeNull()
  })

  it('returns null (never throws) on lookup failure', async () => {
    listPersonas.mockRejectedValue(new Error('boom'))
    expect(await composeInboundOpening(epic())).toBeNull()
  })
})
