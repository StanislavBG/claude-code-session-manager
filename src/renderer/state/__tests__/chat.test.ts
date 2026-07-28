import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * chat.ts's create-vs-resume decision must be driven by the on-disk
 * transcript (mirroring sessions.ts's resolveStartupCommand), not the
 * ephemeral `started` flag — that ephemeral flag is what produced the
 * "Session ID <uuid> is already in use" bug after a reload. window.api is
 * mocked here since vitest runs this suite in a node environment.
 */

function installWindowApiMock(opts: { transcriptExists: boolean; classifyTicket?: (payload: { text: string }) => Promise<'inline' | 'develop'> }) {
  const run = vi.fn().mockResolvedValue(undefined)
  const classifyTicket = vi.fn(opts.classifyTicket ?? (async () => 'inline' as const))
  let needsInputHandler: ((e: { tabId: string; sessionId: string; questions: string[]; answerBody: string; raw: string }) => void) | null = null
  let completeHandler: ((e: { tabId: string; sessionId: string; finalMessage: string }) => void) | null = null
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
      classifyTicket,
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
    getNeedsInputHandler: () => needsInputHandler,
    getCompleteHandler: () => completeHandler,
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

  it('transitions a dequeued ticket to dispatched-to-prd and skips inline dispatch when classified "develop"', async () => {
    const { run, classifyTicket, getCompleteHandler } = installWindowApiMock({
      transcriptExists: true,
      classifyTicket: async () => 'develop',
    })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    useChat.getState().send({ tabId: 't1', sessionId: 's1', cwd: '/proj', prompt: 'build a whole feature' })

    getCompleteHandler()!({ tabId: 't1', sessionId: 's1', finalMessage: 'done with first' })

    await vi.waitFor(() => expect(classifyTicket).toHaveBeenCalledWith({ text: 'build a whole feature' }))

    // Never dispatched inline: chat.run only ever called once (for "first").
    await vi.waitFor(() => {
      const after = useChat.getState().get('t1')
      expect(after.running).toBe(false)
      expect(after.queue).toHaveLength(0)
    })
    expect(run).toHaveBeenCalledTimes(1)

    // A notice turn records the dispatch-to-prd transition.
    const after = useChat.getState().get('t1')
    expect(after.turns.some((t) => t.role === 'notice' && t.text.includes('dispatched to /develop'))).toBe(true)
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
})
