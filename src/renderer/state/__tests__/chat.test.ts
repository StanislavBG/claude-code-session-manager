import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * chat.ts's create-vs-resume decision must be driven by the on-disk
 * transcript (mirroring sessions.ts's resolveStartupCommand), not the
 * ephemeral `started` flag — that ephemeral flag is what produced the
 * "Session ID <uuid> is already in use" bug after a reload. window.api is
 * mocked here since vitest runs this suite in a node environment.
 */

function installWindowApiMock(opts: {
  transcriptExists: boolean
  classifyTicket?: (payload: { text: string }) => Promise<'inline' | 'develop'>
  createPrd?: (payload: unknown) => Promise<{ ok: true; nn: number; filename: string } | { ok: false; status: number; error: string }>
}) {
  const run = vi.fn().mockResolvedValue(undefined)
  const classifyTicket = vi.fn(opts.classifyTicket ?? (async () => 'inline' as const))
  const createPrd = vi.fn(opts.createPrd ?? (async () => ({ ok: true as const, nn: 42, filename: '42-fake-prd.md' })))
  let needsInputHandler: ((e: { tabId: string; sessionId: string; questions: string[]; answerBody: string; raw: string }) => void) | null = null
  let completeHandler: ((e: { tabId: string; sessionId: string; finalMessage: string }) => void) | null = null
  let externalSendHandler: ((e: { tabId: string; prompt: string }) => void) | null = null
  const api = {
    chat: {
      run,
      cancel: vi.fn(),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn((handler) => {
        completeHandler = handler
        return () => { completeHandler = null }
      }),
      onNeedsInput: vi.fn((handler) => {
        needsInputHandler = handler
        return () => { needsInputHandler = null }
      }),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn((handler) => {
        externalSendHandler = handler
        return () => { externalSendHandler = null }
      }),
      classifyTicket,
      createPrd,
    },
    transcripts: {
      pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'),
    },
    config: {
      exists: vi.fn().mockResolvedValue(opts.transcriptExists),
    },
    logs: { write: vi.fn() },
  }
  vi.stubGlobal('window', { api })
  return {
    api,
    run,
    classifyTicket,
    createPrd,
    getNeedsInputHandler: () => needsInputHandler,
    getCompleteHandler: () => completeHandler,
    getExternalSendHandler: () => externalSendHandler,
  }
}

describe('chat.ts send() resume decision', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('resumes when a transcript file already exists on disk', async () => {
    const { api, run } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 'tab-1', sessionId: 'sess-1', cwd: '/proj', prompt: 'hello' })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())

    expect(api.transcripts.pathFor).toHaveBeenCalledWith('/proj', 'sess-1')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-1', sessionId: 'sess-1', resume: true }),
    )
  })

  it('creates fresh when no transcript file exists on disk', async () => {
    const { api, run } = installWindowApiMock({ transcriptExists: false })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 'tab-2', sessionId: 'sess-2', cwd: '/proj', prompt: 'hello' })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())

    expect(api.transcripts.pathFor).toHaveBeenCalledWith('/proj', 'sess-2')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-2', sessionId: 'sess-2', resume: false }),
    )
  })
})

describe('chat.ts resetThread()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('clears turns and run state for the tab', async () => {
    installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.setState({
      chats: {
        't1': {
          turns: [{ id: 'a', role: 'user', text: 'hi', at: 1 }],
          running: false,
          queuedPosition: 0,
          started: true,
          stream: 'partial',
          liveToolUses: [{ id: 'u1', kind: 'tool', label: 'Bash' }],
          queue: [],
        },
      },
    })

    useChat.getState().resetThread('t1')

    const cleared = useChat.getState().get('t1')
    expect(cleared.turns).toEqual([])
    expect(cleared.started).toBe(false)
    expect(cleared.stream).toBe('')
    expect(cleared.liveToolUses).toEqual([])
    expect(cleared.running).toBe(false)
  })
})

describe('chat.ts pushNotice()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('appends a notice turn without touching running/stream/liveToolUses', async () => {
    installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.setState({
      chats: {
        't1': {
          turns: [],
          running: true,
          queuedPosition: 2,
          started: true,
          stream: 'partial',
          liveToolUses: [{ id: 'u1', kind: 'tool', label: 'Bash' }],
          queue: [],
        },
      },
    })

    useChat.getState().pushNotice('t1', '→ opened Skills — showing the live list')

    const after = useChat.getState().get('t1')
    expect(after.turns).toHaveLength(1)
    expect(after.turns[0]).toMatchObject({
      role: 'notice',
      text: '→ opened Skills — showing the live list',
    })
    // Ephemeral notice: must not clobber an in-flight run's live state.
    expect(after.running).toBe(true)
    expect(after.queuedPosition).toBe(2)
    expect(after.stream).toBe('partial')
    expect(after.liveToolUses).toEqual([{ id: 'u1', kind: 'tool', label: 'Bash' }])
  })
})

describe('chat.ts onExternalSend listener (PRD 753)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('resolves the tab from useSessions and hands off to send() when the tab is open', async () => {
    const { api, run } = installWindowApiMock({ transcriptExists: true })
    const { useSessions } = await import('../sessions')
    const { useChat } = await import('../chat')

    useSessions.setState({
      tabs: [
        {
          id: 'tab-ext',
          sessionId: 'sess-ext',
          label: 'ext',
          cwd: '/proj/ext',
          pid: null,
          status: 'dormant',
          exitCode: null,
          startupCommand: null,
          presetId: null,
          generation: 0,
        },
      ],
    })

    const handler = api.chat.onExternalSend.mock.calls[0][0]
    handler({ tabId: 'tab-ext', prompt: 'hello from outside' })

    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-ext', sessionId: 'sess-ext', prompt: 'hello from outside' }),
    )

    const chat = useChat.getState().get('tab-ext')
    expect(chat.turns.some((t) => t.role === 'user' && t.text === 'hello from outside')).toBe(true)
  })

  it('no-ops and logs a warning when the tab is unknown/closed', async () => {
    const { api, run } = installWindowApiMock({ transcriptExists: true })
    const { useSessions } = await import('../sessions')
    await import('../chat')

    useSessions.setState({ tabs: [] })

    const handler = api.chat.onExternalSend.mock.calls[0][0]
    handler({ tabId: 'unknown-tab', prompt: 'hello' })

    expect(run).not.toHaveBeenCalled()
    expect(api.logs.write).toHaveBeenCalledWith('chat', 'warn', expect.stringContaining('unknown-tab'))
  })
})

describe('chat.ts onNeedsInput()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('pushes an answer turn then a question turn when answerBody is non-empty', async () => {
    const { getNeedsInputHandler } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.setState({
      chats: {
        't1': {
          turns: [],
          running: true,
          queuedPosition: 0,
          started: true,
          stream: '',
          liveToolUses: [{ id: 'u1', kind: 'tool', label: 'Bash' }],
          queue: [],
        },
      },
    })

    getNeedsInputHandler()!({
      tabId: 't1',
      sessionId: 's1',
      questions: ['Which env?'],
      answerBody: '1. one\n2. two',
      raw: 'raw text',
    })

    const after = useChat.getState().get('t1')
    expect(after.turns).toHaveLength(2)
    expect(after.turns[0]).toMatchObject({ role: 'assistant', text: '1. one\n2. two' })
    expect(after.turns[0].toolUses).toEqual([{ id: 'u1', kind: 'tool', label: 'Bash' }])
    expect(after.turns[1]).toMatchObject({ role: 'question', text: 'Which env?', questions: ['Which env?'] })
    expect(after.turns[1].toolUses).toEqual([])
    expect(after.running).toBe(false)
  })

  it('pushes only a question turn when answerBody is empty', async () => {
    const { getNeedsInputHandler } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.setState({
      chats: {
        't1': { turns: [], running: true, queuedPosition: 0, started: true, stream: '', liveToolUses: [], queue: [] },
      },
    })

    getNeedsInputHandler()!({
      tabId: 't1',
      sessionId: 's1',
      questions: ['What next?'],
      answerBody: '',
      raw: 'raw text',
    })

    const after = useChat.getState().get('t1')
    expect(after.turns).toHaveLength(1)
    expect(after.turns[0]).toMatchObject({ role: 'question', text: 'What next?' })
  })

  it('finalizes the run\'s ticket as "needs-input" (not "done") and clears it on the next send()', async () => {
    const { run, getNeedsInputHandler } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    // A fresh send establishes an activeTicket for the run that will stall.
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'do the risky thing' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(useChat.getState().get('t1').activeTicket).toBeTruthy()

    getNeedsInputHandler()!({
      tabId: 't1',
      sessionId: 's1',
      questions: ['Which env?'],
      answerBody: '',
      raw: 'raw text',
    })

    const stalled = useChat.getState().get('t1')
    expect(stalled.activeTicket).toBeNull()
    expect(stalled.running).toBe(false)
    const history = stalled.ticketHistory ?? []
    expect(history.some((t) => t.text === 'do the risky thing' && t.status === 'needs-input')).toBe(true)
    expect(history.find((t) => t.status === 'needs-input')?.questionTurnId).toBe(stalled.turns[1].id)

    // The next successful send() for the tab clears the needs-input marker.
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'use staging' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

    const cleared = useChat.getState().get('t1')
    const clearedHistory = cleared.ticketHistory ?? []
    expect(clearedHistory.some((t) => t.status === 'needs-input')).toBe(false)
    expect(clearedHistory.find((t) => t.text === 'do the risky thing')?.status).toBe('done')
  })
})

describe('chat.ts prompt queue', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('queues a second prompt sent while running instead of dropping it', async () => {
    const { run } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(useChat.getState().get('t1').running).toBe(true)

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'second' })

    // Not dropped: it lands in the queue instead of firing a second chat.run.
    expect(run).toHaveBeenCalledTimes(1)
    const queued = useChat.getState().get('t1').queue
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ tabId: 't1', sessionId: 's1', cwd: '/proj', text: 'second', status: 'queued' })
    expect(typeof queued[0].id).toBe('string')
    expect(queued[0].id.length).toBeGreaterThan(0)

    // The queued prompt has not yet appeared as a user turn.
    expect(useChat.getState().get('t1').turns.some((t) => t.text === 'second')).toBe(false)
  })

  it('dequeues and dispatches the next queued ticket, FIFO, once the running turn completes', async () => {
    const { run, getCompleteHandler } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'second' })
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'third' })
    expect(useChat.getState().get('t1').queue.map((t) => t.text)).toEqual(['second', 'third'])

    // Simulate the in-flight run completing.
    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({ tabId: 't1', sessionId: 's1', prompt: 'second' }))

    const afterFirstDequeue = useChat.getState().get('t1')
    expect(afterFirstDequeue.queue.map((t) => t.text)).toEqual(['third'])
    expect(afterFirstDequeue.running).toBe(true)
    expect(afterFirstDequeue.turns.some((t) => t.text === 'second' && t.role === 'user')).toBe(true)

    // Completing the second (dequeued) run dispatches the third, still FIFO.
    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with second' })

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
    expect(run).toHaveBeenNthCalledWith(3, expect.objectContaining({ tabId: 't1', sessionId: 's1', prompt: 'third' }))
    expect(useChat.getState().get('t1').queue).toHaveLength(0)
  })

  it('dispatches a dequeued ticket inline with its ticket id as promptId when classified "inline"', async () => {
    const { run, classifyTicket, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'inline',
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'quick one' })
    const queuedId = useChat.getState().get('t1').queue[0].id

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'quick one' }))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompt: 'quick one', promptId: queuedId }))
    expect(useChat.getState().get('t1').running).toBe(true)
  })

  it('never classifies or dispatches to PRD a ticket tagged "discussion" — it stays an inline conversation', async () => {
    // The classifier is stubbed to 'develop', the verdict that WOULD author a
    // PRD. A 'discussion' ticket must not even reach it: the tag is the user
    // declaring the goal is research, not work to decompose.
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({
      tabId: 't1', sessionId: 's1', cwd: '/proj',
      prompt: 'how should we model epics vs sessions?', tag: 'discussion',
    })
    const queuedId = useChat.getState().get('t1').queue[0].id

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: 'how should we model epics vs sessions?', promptId: queuedId,
    }))
    expect(classifyTicket).not.toHaveBeenCalled()
    expect(createPrd).not.toHaveBeenCalled()
    expect(useChat.getState().get('t1').activeTicket?.status).toBe('running')
  })

  it('transitions a dequeued ticket to dispatched-to-prd, calls createPrd with the mapped payload, and populates prdSlugs when classified "develop"', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => ({ ok: true, nn: 7, filename: '7-build-a-whole-feature.md' }),
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'build a whole feature' })
    const queuedTicket = useChat.getState().get('t1').queue[0]

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'build a whole feature' }))
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))

    const createPrdCall = createPrd.mock.calls[0][0] as { sourcePromptId: string }
    // A "New item" dev-work ticket mints its own real PromptSession — the
    // sourcePromptId is that session's id, never the ticket's own id.
    expect(createPrdCall.sourcePromptId).not.toBe(queuedTicket.id)
    expect(typeof createPrdCall.sourcePromptId).toBe('string')
    expect(createPrd).toHaveBeenCalledWith({
      title: 'build a whole feature',
      cwd: '/proj',
      estimateMinutes: 15,
      goal: 'build a whole feature',
      acceptanceCriteria: ['Implement the request described in Goal.', 'timeout 300 npm run typecheck passes'],
      implementationNotes: 'Target project: /proj',
      sourcePromptId: createPrdCall.sourcePromptId,
      sourceTabId: 't1',
    })

    // Never dispatched inline: chat.run only ever called once (for "first").
    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      expect(after.running).toBe(false)
      expect(after.queue).toHaveLength(0)
    })
    expect(run).toHaveBeenCalledTimes(1)

    // A notice turn records the dispatch-to-prd transition, and prdSlugs is populated.
    const after = useChat.getState().get('t1')
    expect(after.turns.some((t) => t.role === 'notice' && t.text.includes('7-build-a-whole-feature.md'))).toBe(true)
    const dispatchedTicket = after.ticketHistory?.find((t) => t.status === 'dispatched-to-prd')
    expect(dispatchedTicket?.prdSlugs).toEqual(['7-build-a-whole-feature'])
  })

  it('marks a dequeued ticket "failed" with a notice when createPrd rejects', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => { throw new Error('write failed') },
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'build a whole feature' })

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalled())
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))

    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      const failedTicket = after.ticketHistory?.find((t) => t.status === 'failed')
      expect(failedTicket).toBeDefined()
    })

    const after = useChat.getState().get('t1')
    expect(after.turns.some((t) => t.role === 'notice' && t.text.includes('PRD authoring failed') && t.text.includes('write failed'))).toBe(true)
  })

  it('marks a dequeued ticket "failed" with a notice when createPrd resolves not-ok', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => ({ ok: false, status: 400, error: 'cwd rejected' }),
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'build a whole feature' })

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalled())
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))

    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      const failedTicket = after.ticketHistory?.find((t) => t.status === 'failed')
      expect(failedTicket).toBeDefined()
    })

    const after = useChat.getState().get('t1')
    expect(after.turns.some((t) => t.role === 'notice' && t.text.includes('PRD authoring failed') && t.text.includes('cwd rejected'))).toBe(true)
  })

  it('a throwing appendPromptSessionEvent does not mislabel a successful PRD creation as failed (PRD 813)', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => ({ ok: true, nn: 22, filename: '22-real-prd.md' }),
    })
    const { useChat } = await import('../chat')
    const { usePromptSessions } = await import('../promptSessions')
    // Force the PromptSession's own event-chain append to throw (e.g. a
    // stale tail) — the PRD file was still written successfully by this
    // point, so this must never surface as a 'failed' ticket.
    vi.spyOn(usePromptSessions.getState(), 'appendPromptSessionEvent').mockImplementation(() => {
      throw new Error('boom: stale tail')
    })

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'build a whole feature' })
    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalled())
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))

    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      const dispatched = after.ticketHistory?.find((t) => t.text === 'build a whole feature')
      expect(dispatched?.status).toBe('dispatched-to-prd')
      expect(dispatched?.prdSlugs).toEqual(['22-real-prd'])
    })
    const after = useChat.getState().get('t1')
    expect(after.ticketHistory?.some((t) => t.status === 'failed')).toBe(false)
    expect(after.turns.some((t) => t.role === 'notice' && t.text.includes('PRD authoring failed'))).toBe(false)
  })

  it('threads the composer-selected tag from send() through the queued ticket and into the createPrd payload (PRD 774)', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => ({ ok: true, nn: 9, filename: '9-fix-a-bug.md' }),
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'fix a bug', tag: 'bug' })
    const queuedTicket = useChat.getState().get('t1').queue[0]
    expect(queuedTicket.tag).toBe('bug')

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'fix a bug' }))
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))
    expect(createPrd).toHaveBeenCalledWith(expect.objectContaining({ tag: 'bug' }))

    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      const dispatchedTicket = after.ticketHistory?.find((t) => t.status === 'dispatched-to-prd')
      expect(dispatchedTicket?.tag).toBe('bug')
    })
  })

  it('carries the composer-selected tag into the fresh-send activeTicket (not just the queued path)', async () => {
    const { run } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first', tag: 'feature' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    expect(useChat.getState().get('t1').activeTicket?.tag).toBe('feature')
  })

  it('stays "running" during the classification round-trip so a send() during that window queues instead of racing a second dispatch', async () => {
    let resolveClassify!: (v: 'inline' | 'develop') => void
    const classifyGate = new Promise<'inline' | 'develop'>((resolve) => { resolveClassify = resolve })
    const { run, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: () => classifyGate,
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'second' })
    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    // Classification is now pending (classifyGate unresolved) — the store
    // must still report running:true, not drop back to false.
    await vi.waitFor(() => expect(useChat.getState().get('t1').queue).toHaveLength(0))
    expect(useChat.getState().get('t1').running).toBe(true)

    // A send() arriving during this window must queue, not fire a second
    // concurrent chat.run for the same tab.
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'third' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(useChat.getState().get('t1').queue.map((t) => t.text)).toEqual(['third'])

    resolveClassify('inline')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompt: 'second' }))
  })

  it('dispatches an external-origin ticket queued while busy inline, without ever classifying or creating a PRD', async () => {
    const { run, classifyTicket, createPrd, getExternalSendHandler, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
    })
    const { useChat } = await import('../chat')
    const { useSessions } = await import('../sessions')
    useSessions.setState({
      tabs: [{ id: 't1', sessionId: 's1', cwd: '/proj' } as any],
    } as any)

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    // Simulate a scheduler completion notification arriving via onExternalSend
    // while the tab is busy — this is the exact path that previously got
    // misclassified as 'develop' and created a garbage PRD.
    getExternalSendHandler()!({ tabId: 't1', prompt: 'PRD 793 finished: completed. Check Scheduler for details.' })

    const queued = useChat.getState().get('t1').queue
    expect(queued).toHaveLength(1)
    expect(queued[0].external).toBe(true)

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tabId: 't1', sessionId: 's1', prompt: 'PRD 793 finished: completed. Check Scheduler for details.' }),
    )

    expect(classifyTicket).not.toHaveBeenCalled()
    expect(createPrd).not.toHaveBeenCalled()
    expect(useChat.getState().get('t1').running).toBe(true)
  })
})

describe('chat.ts isChainResolved() (PRD 775)', () => {
  it('is unresolved when the ticket has no prdSlugs', async () => {
    const { isChainResolved } = await import('../chat')
    expect(isChainResolved({ prdSlugs: [] } as any, [])).toBe(false)
    expect(isChainResolved({} as any, [])).toBe(false)
  })

  it('is unresolved when at least one slug lacks a completed job', async () => {
    const { isChainResolved } = await import('../chat')
    const ticket = { prdSlugs: ['a', 'b'] } as any
    expect(isChainResolved(ticket, [{ slug: 'a', status: 'completed' }])).toBe(false)
    expect(
      isChainResolved(ticket, [
        { slug: 'a', status: 'completed' },
        { slug: 'b', status: 'running' },
      ]),
    ).toBe(false)
  })

  it('is resolved once every slug in prdSlugs has scheduler job status "completed"', async () => {
    const { isChainResolved } = await import('../chat')
    const ticket = { prdSlugs: ['a', 'b'] } as any
    expect(
      isChainResolved(ticket, [
        { slug: 'a', status: 'completed' },
        { slug: 'b', status: 'completed' },
      ]),
    ).toBe(true)
  })
})

describe('chat.ts open-chain selection for the composer picker (PRD 775)', () => {
  // Mirrors the filter TerminalChat.tsx applies to build its picker list:
  // dispatched-to-prd ROOT tickets (no chainRootId) that are NOT resolved.
  function openChains(history: any[], jobs: { slug: string; status: string }[]) {
    return history.filter((t) => t.status === 'dispatched-to-prd' && !t.chainRootId && !isChainResolvedRef!(t, jobs))
  }
  let isChainResolvedRef: ((t: any, jobs: any[]) => boolean) | undefined

  beforeEach(async () => {
    vi.resetModules()
    vi.unstubAllGlobals()
    const { isChainResolved } = await import('../chat')
    isChainResolvedRef = isChainResolved
  })

  it('yields no open chains (defaults to "New item") when ticketHistory has no dispatched-to-prd tickets', () => {
    expect(openChains([{ id: 't1', status: 'done' }], [])).toEqual([])
  })

  it('offers one open item for a single unresolved dispatched-to-prd root ticket', () => {
    const root = { id: 'root-1', status: 'dispatched-to-prd', prdSlugs: ['1-a'] }
    expect(openChains([root], [{ slug: '1-a', status: 'running' }])).toEqual([root])
  })

  it('stops offering a chain once every one of its prdSlugs has scheduler job status "completed"', () => {
    const root = { id: 'root-1', status: 'dispatched-to-prd', prdSlugs: ['1-a'] }
    expect(openChains([root], [{ slug: '1-a', status: 'completed' }])).toEqual([])
  })

  it('excludes a follow-up ticket itself (chainRootId set) even if dispatched-to-prd', () => {
    const followUp = { id: 'follow-1', status: 'dispatched-to-prd', chainRootId: 'root-1' }
    expect(openChains([followUp], [])).toEqual([])
  })
})

describe('chat.ts chain continuation (PRD 775)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('continuing an open chain: sourcePromptId is the ROOT ticket id, and the new slug is appended to the ROOT ticket\'s prdSlugs (not the follow-up ticket\'s)', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => ({ ok: true, nn: 10, filename: '10-second-prd.md' }),
    })
    const { useChat } = await import('../chat')

    // Seed ticketHistory with an already-dispatched, unresolved root chain.
    useChat.setState({
      chats: {
        t1: {
          turns: [],
          running: false,
          queuedPosition: 0,
          started: true,
          stream: '',
          liveToolUses: [],
          queue: [],
          activeTicket: null,
          ticketHistory: [
            {
              id: 'root-1',
              tabId: 't1',
              sessionId: 's1',
              cwd: '/proj',
              text: 'first initiative',
              status: 'dispatched-to-prd',
              createdAt: 1,
              completedAt: 2,
              prdSlugs: ['9-first-prd'],
              promptSessionId: 'psess-root-1',
            },
          ],
        },
      },
    })

    // Kick off a running turn so the follow-up prompt queues (only queued
    // tickets go through classification/dispatch-to-prd).
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'kick off running' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({
      tabId: 't1',
      sessionId: 's1',
      cwd: '/proj',
      prompt: 'continue the initiative',
      chainRootId: 'root-1',
    })
    const queuedTicket = useChat.getState().get('t1').queue[0]
    expect(queuedTicket.chainRootId).toBe('root-1')

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with kickoff' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'continue the initiative' }))
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))
    // A continuation reuses the ROOT ticket's already-minted PromptSession
    // id — never mints a second one for the same chain.
    expect(createPrd).toHaveBeenCalledWith(expect.objectContaining({ sourcePromptId: 'psess-root-1' }))

    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      const root = after.ticketHistory?.find((t) => t.id === 'root-1')
      expect(root?.prdSlugs).toEqual(['9-first-prd', '10-second-prd'])
    })

    const after = useChat.getState().get('t1')
    const followUp = after.ticketHistory?.find((t) => t.text === 'continue the initiative')
    expect(followUp?.status).toBe('dispatched-to-prd')
    expect(followUp?.prdSlugs).toBeUndefined()
  })

  it('choosing "New item" (no chainRootId) creates an independent ticket using its own id as sourcePromptId, even while a chain is open', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => ({ ok: true, nn: 11, filename: '11-independent-prd.md' }),
    })
    const { useChat } = await import('../chat')

    useChat.setState({
      chats: {
        t1: {
          turns: [],
          running: false,
          queuedPosition: 0,
          started: true,
          stream: '',
          liveToolUses: [],
          queue: [],
          activeTicket: null,
          ticketHistory: [
            {
              id: 'root-1',
              tabId: 't1',
              sessionId: 's1',
              cwd: '/proj',
              text: 'first initiative',
              status: 'dispatched-to-prd',
              createdAt: 1,
              completedAt: 2,
              prdSlugs: ['9-first-prd'],
            },
          ],
        },
      },
    })

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'kick off running' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    // Explicit "New item" — no chainRootId passed, even though root-1 is open.
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'a totally new thing' })
    const queuedTicket = useChat.getState().get('t1').queue[0]
    expect(queuedTicket.chainRootId).toBeUndefined()

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with kickoff' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'a totally new thing' }))
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))

    // "New item" mints its own independent PromptSession — sourcePromptId is
    // that fresh session's id, never the ticket's own id or the open root's.
    const newTicketId = queuedTicket.id
    const createPrdCall = createPrd.mock.calls[0][0] as { sourcePromptId: string }
    expect(createPrdCall.sourcePromptId).not.toBe(newTicketId)
    expect(typeof createPrdCall.sourcePromptId).toBe('string')

    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      const dispatched = after.ticketHistory?.find((t) => t.text === 'a totally new thing')
      expect(dispatched?.prdSlugs).toEqual(['11-independent-prd'])
    })

    // The root chain's own prdSlugs are untouched by the independent ticket.
    const after = useChat.getState().get('t1')
    const root = after.ticketHistory?.find((t) => t.id === 'root-1')
    expect(root?.prdSlugs).toEqual(['9-first-prd'])
  })

  it('mints exactly one real PromptSession for a fresh dev-work ticket, and a continuation reuses it without minting a second one (PRD 813)', async () => {
    const { run, classifyTicket, createPrd, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
      createPrd: async () => ({ ok: true, nn: 20, filename: '20-first-prd.md' }),
    })
    const { useChat } = await import('../chat')
    const { usePromptSessions } = await import('../promptSessions')
    const createSpy = vi.spyOn(usePromptSessions.getState(), 'createPromptSession')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'kick off 1' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'new dev work' })
    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with kickoff 1' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'new dev work' }))
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(1))
    expect(createSpy).toHaveBeenCalledTimes(1)

    const root = useChat.getState().get('t1').ticketHistory?.find((t) => t.text === 'new dev work')
    expect(root?.promptSessionId).toBeTruthy()
    expect(usePromptSessions.getState().sessions[root!.promptSessionId!]).toBeDefined()

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'kick off 2' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    useChat.getState().send({
      tabId: 't1',
      sessionId: 's1',
      cwd: '/proj',
      prompt: 'continue dev work',
      chainRootId: root!.id,
    })
    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with kickoff 2' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'continue dev work' }))
    await vi.waitFor(() => expect(createPrd).toHaveBeenCalledTimes(2))

    // Still exactly one PromptSession minted overall — the continuation
    // reused the root's, it did not mint a second one.
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(createPrd.mock.calls[1][0]).toMatchObject({ sourcePromptId: root!.promptSessionId })
  })
})

describe('chat.ts dispatchSend() activeTicket (immediate send)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('sets an activeTicket for the very first/immediate send, not only for a dequeued one', async () => {
    const { run } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    const state = useChat.getState().get('t1')
    expect(state.running).toBe(true)
    expect(state.activeTicket).toBeTruthy()
    expect(state.activeTicket).toMatchObject({
      tabId: 't1',
      sessionId: 's1',
      cwd: '/proj',
      text: 'first',
      status: 'running',
    })
    expect(typeof state.activeTicket!.id).toBe('string')
    expect(state.activeTicket!.id.length).toBeGreaterThan(0)
  })

  it('folds the immediate-send activeTicket into ticketHistory as "done" on completion', async () => {
    const { run, getCompleteHandler } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(useChat.getState().get('t1').activeTicket).toBeTruthy()

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done' })

    const after = useChat.getState().get('t1')
    expect(after.activeTicket).toBeNull()
    const history = after.ticketHistory ?? []
    expect(history.some((t) => t.text === 'first' && t.status === 'done')).toBe(true)
  })
})

describe('chat.ts queue-panel ticket lifecycle (PRD 750)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('keeps a queued ticket visible in queue (status queued) while another turn is running', async () => {
    const { run } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'second' })

    const state = useChat.getState().get('t1')
    expect(state.running).toBe(true)
    expect(state.queue).toHaveLength(1)
    expect(state.queue[0]).toMatchObject({ text: 'second', status: 'queued' })
  })

  it("promotes a dequeued ticket's status queued -> running -> done as the store transitions it, and keeps it visible in ticketHistory afterward", async () => {
    const { run, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'inline',
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'second' })
    expect(useChat.getState().get('t1').queue[0].status).toBe('queued')

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    // Dequeued: now the in-flight ticket, status updated to 'running'.
    await vi.waitFor(() => expect(useChat.getState().get('t1').activeTicket?.status).toBe('running'))
    expect(useChat.getState().get('t1').activeTicket?.text).toBe('second')
    expect(useChat.getState().get('t1').queue).toHaveLength(0)

    // Completing its run finalizes it as 'done' — folded into ticketHistory,
    // not dropped, so it stays visible in the queue panel post-completion.
    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with second' })
    await vi.waitFor(() => expect(useChat.getState().get('t1').activeTicket).toBeNull())
    const history = useChat.getState().get('t1').ticketHistory ?? []
    expect(history.some((t) => t.text === 'second' && t.status === 'done')).toBe(true)
  })

  it('finalizes the in-flight ticket as "failed" (not "done") when the run errors', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const classifyTicket = vi.fn(async () => 'inline' as const)
    let errorHandler: ((e: { tabId: string; sessionId: string; message: string }) => void) | null = null
    let completeHandler: ((e: { tabId: string; sessionId: string; finalMessage: string }) => void) | null = null
    vi.stubGlobal('window', {
      api: {
        chat: {
          run,
          cancel: vi.fn(),
          onQueued: vi.fn(),
          onRunStarted: vi.fn(),
          onOutput: vi.fn(),
          onToolUse: vi.fn(),
          onComplete: vi.fn((h) => { completeHandler = h; return () => { completeHandler = null } }),
          onNeedsInput: vi.fn(),
          onError: vi.fn((h) => { errorHandler = h; return () => { errorHandler = null } }),
          onNotice: vi.fn(),
          onExternalSend: vi.fn(),
          classifyTicket,
        },
        transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
        config: { exists: vi.fn().mockResolvedValue(true) },
        logs: { write: vi.fn() },
      },
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'second' })
    completeHandler!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(useChat.getState().get('t1').activeTicket?.status).toBe('running'))

    errorHandler!({ tabId: 't1', sessionId: 's1', message: 'boom' })

    await vi.waitFor(() => expect(useChat.getState().get('t1').activeTicket).toBeNull())
    const history = useChat.getState().get('t1').ticketHistory ?? []
    expect(history.some((t) => t.text === 'second' && t.status === 'failed')).toBe(true)
  })
})
