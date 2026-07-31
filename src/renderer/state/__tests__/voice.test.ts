import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * PRD: dormant-tab voice delivery. Since PRD 772 made new tabs default to
 * `status: 'dormant'` (Chat view, no PTY spawned), voice.ts's onFinal/armSubmit
 * previously had nowhere to deliver a transcript for such a tab — pty.write is
 * a no-op with no process on the other end. These tests assert the second
 * delivery path: a dormant tab routes the transcript into the chat store's
 * pendingVoiceText instead, and auto-submit dispatches via chat.send() instead
 * of a pty '\r' keystroke. Live (non-dormant) tabs must remain byte-identical
 * to the pre-existing pty.write behavior — the regression checks assert that
 * explicitly, not just by omission.
 */

let capturedOpts: any = null

vi.mock('../../lib/speechRecognition', () => ({
  createRecognition: vi.fn((opts: any) => {
    capturedOpts = opts
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      setVadThresholds: vi.fn(),
      getAnalyser: vi.fn(() => null),
    }
  }),
  isRecognitionSupported: vi.fn(() => true),
  preloadModel: vi.fn(),
  resetModel: vi.fn(),
}))

vi.mock('../../lib/vadDucking', () => ({
  attachVadDucking: vi.fn(() => () => {}),
}))

vi.mock('../../lib/speechSynthesis', () => ({
  stopSpeaking: vi.fn(),
  isSpeaking: vi.fn(() => false),
  getSpeakStartedAt: vi.fn(() => null),
}))

function installWindowApiMock() {
  // The submit guard's rAF loop isn't under test here (it only preempts the
  // countdown on live mic input) — stub it as a no-op so armSubmit's
  // setTimeout path (under test) runs in this node environment.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const ptyWrite = vi.fn()
  const chatRun = vi.fn().mockResolvedValue(undefined)
  const api = {
    pty: { write: ptyWrite },
    voice: { getDevicePref: vi.fn().mockResolvedValue(null) },
    chat: {
      run: chatRun,
      cancel: vi.fn(),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(),
      createPrd: vi.fn(),
    },
    transcripts: {
      pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'),
    },
    config: {
      exists: vi.fn().mockResolvedValue(true),
    },
    logs: { write: vi.fn() },
  }
  vi.stubGlobal('window', { api })
  return { api, ptyWrite, chatRun }
}

type TabStatus = 'dormant' | 'spawning' | 'running' | 'exited'

function makeTab(overrides: Partial<{ id: string; status: TabStatus; sessionId: string; cwd: string }> = {}) {
  return {
    id: overrides.id ?? 't1',
    sessionId: overrides.sessionId ?? 's1',
    label: 't1',
    cwd: overrides.cwd ?? '/proj',
    pid: null,
    status: overrides.status ?? ('dormant' as TabStatus),
    exitCode: null,
    startupCommand: null,
    presetId: null,
    generation: 0,
  }
}

/** Drives startRecording through its async getDevicePref hop so createRecognition's opts are captured. */
async function startAndCapture(useVoice: any, tabId: string, startOpts?: { sink?: (text: string) => void }) {
  useVoice.getState().startRecording(tabId, startOpts)
  await vi.waitFor(() => expect(capturedOpts).not.toBeNull())
  const opts = capturedOpts
  capturedOpts = null
  return opts
}

describe('voice.ts onFinal — dormant vs live tab delivery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    capturedOpts = null
  })

  it('routes the transcript to the chat store instead of pty.write for a dormant tab', async () => {
    const { ptyWrite } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useChat } = await import('../chat')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [makeTab({ id: 't1', status: 'dormant' })] })

    const opts = await startAndCapture(useVoice, 't1')
    opts.onFinal('hello from voice')

    expect(ptyWrite).not.toHaveBeenCalled()
    expect(useChat.getState().chats['t1']?.pendingVoiceText).toBe('hello from voice')
  })

  it('regression: a running-status tab still uses pty.write, not the chat store', async () => {
    const { ptyWrite } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useChat } = await import('../chat')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [makeTab({ id: 't1', status: 'running' })] })

    const opts = await startAndCapture(useVoice, 't1')
    opts.onFinal('hello from voice')

    expect(ptyWrite).toHaveBeenCalledWith({ tabId: 't1', data: 'hello from voice' })
    expect(useChat.getState().chats['t1']?.pendingVoiceText).toBeUndefined()
  })

  it('a matched voice command is skipped for a dormant tab — treated as literal text, not dispatched as a control sequence', async () => {
    const { ptyWrite } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useChat } = await import('../chat')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [makeTab({ id: 't1', status: 'dormant' })] })

    const opts = await startAndCapture(useVoice, 't1')
    opts.onFinal('cancel')

    // Not treated as the "cancel" voice command (which would pty.write \x1b).
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(useChat.getState().chats['t1']?.pendingVoiceText).toBe('cancel')
  })

  it('regression: a matched voice command still dispatches its control sequence for a live tab', async () => {
    const { ptyWrite } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [makeTab({ id: 't1', status: 'running' })] })

    const opts = await startAndCapture(useVoice, 't1')
    opts.onFinal('cancel')

    expect(ptyWrite).toHaveBeenCalledWith({ tabId: 't1', data: '\x1b' })
  })
})

describe('voice.ts onFinal — sink mode (e.g. EpicComposer dictation)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    capturedOpts = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands the transcript to the sink instead of pty.write, with no tab lookup involved', async () => {
    const { ptyWrite } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useVoice } = await import('../voice')

    // No tab exists for this id at all — sink mode must not depend on one.
    useSessions.setState({ tabs: [] })

    const sink = vi.fn()
    const opts = await startAndCapture(useVoice, 'epic-1', { sink })
    opts.onFinal('add a mic button')

    expect(sink).toHaveBeenCalledWith('add a mic button')
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(useVoice.getState().isRecording).toBe(true)
  })

  it('does not arm the auto-submit countdown in sink mode', async () => {
    const { ptyWrite, chatRun } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [] })

    const sink = vi.fn()
    const opts = await startAndCapture(useVoice, 'epic-1', { sink })
    opts.onFinal('add a mic button')

    await vi.advanceTimersByTimeAsync(useVoice.getState().submitDelayMs)

    expect(ptyWrite).not.toHaveBeenCalled()
    expect(chatRun).not.toHaveBeenCalled()
  })

  it('does not treat a matched voice command specially in sink mode — delivered as literal text', async () => {
    const { ptyWrite } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [] })

    const sink = vi.fn()
    const opts = await startAndCapture(useVoice, 'epic-1', { sink })
    opts.onFinal('cancel')

    expect(sink).toHaveBeenCalledWith('cancel')
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('a later plain startRecording(tabId) does not inherit a stale sink', async () => {
    const { ptyWrite } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [makeTab({ id: 't1', status: 'running' })] })

    const sink = vi.fn()
    await startAndCapture(useVoice, 'epic-1', { sink })
    useVoice.getState().stopRecording()
    await vi.waitFor(() => expect(useVoice.getState().isRecording).toBe(false))

    const opts = await startAndCapture(useVoice, 't1')
    opts.onFinal('hello from voice')

    expect(sink).not.toHaveBeenCalled()
    expect(ptyWrite).toHaveBeenCalledWith({ tabId: 't1', data: 'hello from voice' })
  })
})

describe("voice.ts armSubmit's countdown — dormant vs live tab dispatch", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    capturedOpts = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls chat.send() with the pending voice text for a dormant tab, and clears pendingVoiceText', async () => {
    const { chatRun } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useChat } = await import('../chat')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [makeTab({ id: 't1', status: 'dormant', sessionId: 's1', cwd: '/proj' })] })

    const opts = await startAndCapture(useVoice, 't1')
    opts.onFinal('hello from voice')
    expect(useChat.getState().chats['t1']?.pendingVoiceText).toBe('hello from voice')

    await vi.advanceTimersByTimeAsync(useVoice.getState().submitDelayMs)

    expect(chatRun).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 't1', sessionId: 's1', prompt: 'hello from voice' }),
    )
    expect(useChat.getState().chats['t1']?.pendingVoiceText).toBeUndefined()
  })

  it('regression: fires a pty \\r keystroke (not chat.send) for a live tab', async () => {
    const { ptyWrite, chatRun } = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useVoice } = await import('../voice')

    useSessions.setState({ tabs: [makeTab({ id: 't1', status: 'running' })] })

    const opts = await startAndCapture(useVoice, 't1')
    opts.onFinal('hello from voice')

    await vi.advanceTimersByTimeAsync(useVoice.getState().submitDelayMs)

    expect(ptyWrite).toHaveBeenCalledWith({ tabId: 't1', data: '\r' })
    expect(chatRun).not.toHaveBeenCalled()
  })
})
