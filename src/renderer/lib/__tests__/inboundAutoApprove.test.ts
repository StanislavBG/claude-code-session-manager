import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useChat } from '../../state/chat'
import { autoApproveInbound, approveStampedInbound } from '../inboundAutoApprove'

const CWD = '/tmp/proj'

function epic(id: string, over: Partial<PromptSession> = {}): PromptSession {
  return {
    id,
    cwd: CWD,
    goalText: `goal ${id}`,
    claudeSessionId: `sid-${id}`,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    completedAt: null,
    openingPrompt: `opening ${id}`,
    ...over,
  } as PromptSession
}

const stamp = {
  requestedBy: 'human' as const,
  quote: 'do it',
  verifiedAt: '2026-10-11T00:00:00.000Z',
  fromClaudeSessionId: 'from-1',
}

describe('inboundAutoApprove', () => {
  let send: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        pty: { kill: vi.fn() },
        promptSessions: {
          mergeActiveIndex: vi.fn().mockResolvedValue({ sessions: {}, events: {} }),
          onEventAppended: vi.fn(),
        },
        auditLog: { append: vi.fn().mockResolvedValue({ ok: true }) },
        config: { writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }) },
      },
    })
    send = vi.fn()
    useChat.setState({ send } as never)
    vi.spyOn(usePromptSessions.getState(), 'hydrate').mockResolvedValue(undefined)
    usePromptSessions.setState({
      hydrate: vi.fn().mockResolvedValue(undefined),
      sessions: {
        stamped: epic('stamped', {
          source: { producer: 'cross-project-feedback', autoApprove: stamp },
        }),
        unstamped: epic('unstamped', { source: { producer: 'cross-project-feedback' } }),
        local: epic('local', { source: { producer: 'new-epic-ui' } }),
      },
    } as never)
  })

  it('approves a stamped inbound Epic and sends with origin inbound-proposal', async () => {
    const { autoApproveInbound: run } = await import('../inboundAutoApprove')
    await run(CWD)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'stamped',
        sessionId: 'sid-stamped',
        cwd: CWD,
        prompt: 'opening stamped',
        origin: 'inbound-proposal',
      }),
    )
    expect(usePromptSessions.getState().sessions.stamped.status).toBe('active')
  })

  it('leaves unstamped inbound and locally-created Epics untouched', async () => {
    await autoApproveInbound(CWD)
    const s = usePromptSessions.getState().sessions
    expect(s.unstamped.status).toBe('proposed')
    expect(s.local.status).toBe('proposed')
  })

  it('is idempotent', async () => {
    await autoApproveInbound(CWD)
    await autoApproveInbound(CWD)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('honours the epicId filter', async () => {
    await autoApproveInbound(CWD, 'unstamped')
    expect(send).not.toHaveBeenCalled()
  })

  it('approveStampedInbound never hydrates (a second hydrate would clobber in-memory sessions)', async () => {
    const hydrate = vi.fn()
    usePromptSessions.setState({ hydrate } as never)
    await approveStampedInbound(CWD)
    expect(hydrate).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('starts a macro-stamped Epic and ignores an unknown requestedBy', async () => {
    usePromptSessions.setState({
      sessions: {
        macro: epic('macro', {
          source: {
            producer: 'cross-project-feedback',
            autoApprove: {
              requestedBy: 'macro',
              macroId: 'm1',
              macroLabel: 'Fable',
              verifiedAt: '2026-10-11T00:00:00.000Z',
              fromClaudeSessionId: 'from-1',
            },
          },
        }),
        weird: epic('weird', {
          source: { producer: 'cross-project-feedback', autoApprove: { requestedBy: 'robot' } as never },
        }),
      },
    } as never)
    await approveStampedInbound(CWD)
    const s = usePromptSessions.getState().sessions
    expect(s.macro.status).toBe('active')
    expect(s.weird.status).toBe('proposed')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('leaves a plain proposed and a completed Epic untouched', async () => {
    usePromptSessions.setState({
      sessions: {
        plain: epic('plain'),
        done: epic('done', {
          status: 'completed',
          source: { producer: 'cross-project-feedback', autoApprove: stamp },
        }),
      },
    } as never)
    await approveStampedInbound(CWD)
    const s = usePromptSessions.getState().sessions
    expect(s.plain.status).toBe('proposed')
    expect(s.done.status).toBe('completed')
    expect(send).not.toHaveBeenCalled()
  })

  it('overlapping approveStampedInbound calls start the Epic once, no error toast', async () => {
    await Promise.all([approveStampedInbound(CWD), approveStampedInbound(CWD)])
    expect(send).toHaveBeenCalledTimes(1)
    expect(usePromptSessions.getState().sessions.stamped.status).toBe('active')
  })
})
