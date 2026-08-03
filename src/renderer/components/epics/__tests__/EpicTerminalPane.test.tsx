// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

/**
 * EpicTerminalPane (PRD 831) — the Epic Terminal-mode PTY pane. @xterm/xterm
 * needs matchMedia/canvas that plain jsdom doesn't provide, so both xterm
 * packages are stubbed with a minimal fake; this exercises the pane's own
 * lifecycle: spawn keyed by claudeSessionId, attached-flag bookkeeping,
 * resume command, and the exited -> "Back to Chat" handoff.
 */

vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    onData = vi.fn(() => () => {})
    onResize = vi.fn(() => () => {})
  }
  return { Terminal: FakeTerm }
})
vi.mock('@xterm/addon-fit', () => {
  class FakeFit {
    fit = vi.fn()
  }
  return { FitAddon: FakeFit }
})

function installWindowApiMock() {
  let dataHandler: ((data: string) => void) | null = null
  let exitHandler: ((info: { exitCode: number | null }) => void) | null = null
  const spawn = vi.fn().mockResolvedValue({ pid: 123, cwd: '/proj', reattached: false })
  const write = vi.fn()
  const kill = vi.fn()
  const resize = vi.fn()
  const api = {
    pty: {
      spawn,
      write,
      resize,
      kill,
      onData: vi.fn((_id: string, handler: (data: string) => void) => {
        dataHandler = handler
        return () => { dataHandler = null }
      }),
      onExit: vi.fn((_id: string, handler: (info: { exitCode: number | null }) => void) => {
        exitHandler = handler
        return () => { exitHandler = null }
      }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, spawn, write, kill, resize, fireExit: (info: { exitCode: number | null }) => exitHandler?.(info) }
}

/** Fuller mock for mounting the real EpicDetail (not just EpicTerminalPane in
 *  isolation) — needed by the remount regression test below. */
function installFullWindowApiMock() {
  const { spawn, write, kill, resize } = installWindowApiMock()
  const fullApi = window.api as unknown as Record<string, unknown>
  Object.assign(fullApi, {
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(() => () => {}),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
    },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
    },
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
    logs: { write: vi.fn() },
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
  })
  return { spawn, write, kill, resize }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('EpicTerminalPane (PRD 831)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    delete (window as unknown as { api?: unknown }).api
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    vi.useRealTimers()
  })

  it('spawns the pty keyed by claudeSessionId in the Epic cwd and marks the Epic attached', async () => {
    const { spawn } = installWindowApiMock()
    const { useEpicTerminal } = await import('../../../state/epicTerminal')
    const { EpicTerminalPane } = await import('../EpicTerminalPane')

    mount(
      createElement(EpicTerminalPane, {
        epicId: 'epic-1',
        cwd: '/proj',
        sessionId: 'claude-session-abc',
        onReturnToChat: () => {},
      }),
    )

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'claude-session-abc', cwd: '/proj' }))
    expect(useEpicTerminal.getState().isAttached('epic-1')).toBe(true)
  })

  it('writes a --resume command with the session id after spawning', async () => {
    const { write } = installWindowApiMock()
    const { EpicTerminalPane } = await import('../EpicTerminalPane')

    mount(
      createElement(EpicTerminalPane, {
        epicId: 'epic-1',
        cwd: '/proj',
        sessionId: 'claude-session-abc',
        onReturnToChat: () => {},
      }),
    )

    await flushAsync(2)
    act(() => { vi.advanceTimersByTime(1600) })

    const resumeWrite = write.mock.calls.find(([payload]) => payload.data.includes('--resume'))
    expect(resumeWrite).toBeTruthy()
    expect(resumeWrite![0].data).toContain('claude-session-abc')
    expect(resumeWrite![0].tabId).toBe('claude-session-abc')
  })

  it('clears attached and shows exited state with a working "Back to Chat" handoff on pty exit', async () => {
    const { fireExit, kill } = installWindowApiMock()
    const { useEpicTerminal } = await import('../../../state/epicTerminal')
    const { EpicTerminalPane } = await import('../EpicTerminalPane')

    const onReturnToChat = vi.fn()
    const el = mount(
      createElement(EpicTerminalPane, {
        epicId: 'epic-1',
        cwd: '/proj',
        sessionId: 'claude-session-abc',
        onReturnToChat,
      }),
    )

    await flushAsync(1)
    act(() => { fireExit({ exitCode: 0 }) })

    expect(useEpicTerminal.getState().isAttached('epic-1')).toBe(false)
    const exitedPanel = el.querySelector('[data-testid="epic-terminal-exited"]')
    expect(exitedPanel).not.toBeNull()

    const backBtn = el.querySelector('[data-testid="epic-terminal-back-to-chat"]') as HTMLButtonElement
    act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onReturnToChat).toHaveBeenCalledTimes(1)

    // Unmount must NOT kill: teardown is owned by the explicit exits (Chat
    // toggle / Mark completed) and by the pty's own exit, never by the pane
    // going away — this pane unmounts every time the user views another Epic.
    act(() => root?.unmount())
    root = null
    expect(kill).not.toHaveBeenCalled()
    expect(useEpicTerminal.getState().isAttached('epic-1')).toBe(false)
  })

  // The regression this whole change exists to prevent: browsing to another
  // Epic used to SIGKILL the live claude behind the one you left, so returning
  // got a cold `--resume` with the session's in-flight context gone.
  it('leaves the pty running and the Epic attached when the pane unmounts because another Epic was selected', async () => {
    const { kill } = installWindowApiMock()
    const { useEpicTerminal } = await import('../../../state/epicTerminal')
    const { EpicTerminalPane } = await import('../EpicTerminalPane')

    mount(
      createElement(EpicTerminalPane, {
        epicId: 'epic-1',
        cwd: '/proj',
        sessionId: 'claude-session-abc',
        onReturnToChat: vi.fn(),
      }),
    )
    await flushAsync(1)
    expect(useEpicTerminal.getState().isAttached('epic-1')).toBe(true)

    act(() => root?.unmount())
    root = null

    expect(kill).not.toHaveBeenCalled()
    // Still attached: a live interactive claude owns this claudeSessionId, so
    // chat.ts's send() guard must keep refusing a headless --resume for it.
    expect(useEpicTerminal.getState().isAttached('epic-1')).toBe(true)
  })

  it('regression: switching the selected Epic while both are in Terminal mode spawns a fresh pty for the new Epic instead of reusing the stale instance', async () => {
    const { spawn } = installFullWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useEpicTerminal } = await import('../../../state/epicTerminal')
    const { EpicDetail } = await import('../EpicDetail')

    const sessionA = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic A', 'feature')
    const sessionB = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic B', 'feature')
    useEpicTerminal.getState().setMode(sessionA.id, 'terminal')
    useEpicTerminal.getState().setMode(sessionB.id, 'terminal')

    mount(createElement(EpicDetail, { promptSession: sessionA }))
    await flushAsync(1)
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: sessionA.claudeSessionId }))

    act(() => { root!.render(createElement(EpicDetail, { promptSession: sessionB })) })
    await flushAsync(1)

    // Without the sessionId `key` on EpicTerminalPane, React would reuse the
    // same instance (spawnedRef already true) and never spawn for Epic B.
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: sessionB.claudeSessionId }))
  })

  it('PRD 833 I3: reattaching to a surviving pty never re-types the launch command', async () => {
    const { spawn, write } = installWindowApiMock()
    spawn.mockResolvedValue({ pid: 123, cwd: '/proj', reattached: true })
    const { EpicTerminalPane } = await import('../EpicTerminalPane')

    mount(
      createElement(EpicTerminalPane, {
        epicId: 'epic-1',
        cwd: '/proj',
        sessionId: 'claude-session-abc',
        onReturnToChat: () => {},
      }),
    )

    await flushAsync(2)
    act(() => { vi.advanceTimersByTime(2000) })

    // The surviving claude REPL must not receive the literal launch command
    // as a prompt — no write at all until the user types.
    const cmdWrite = write.mock.calls.find(([payload]) => payload.data.includes('claude '))
    expect(cmdWrite).toBeUndefined()
  })

  it('PRD 833 I2: a session with no transcript yet launches with --session-id, not --resume', async () => {
    const { write } = installWindowApiMock()
    // transcriptExists probes pathFor + exists; report "no transcript".
    const fullApi = window.api as unknown as Record<string, unknown>
    Object.assign(fullApi, {
      transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
      config: { exists: vi.fn().mockResolvedValue(false) },
    })
    const { EpicTerminalPane } = await import('../EpicTerminalPane')

    mount(
      createElement(EpicTerminalPane, {
        epicId: 'epic-1',
        cwd: '/proj',
        sessionId: 'claude-session-new',
        onReturnToChat: () => {},
      }),
    )

    await flushAsync(3)
    act(() => { vi.advanceTimersByTime(1600) })

    const cmdWrite = write.mock.calls.find(([payload]) => payload.data.includes('claude '))
    expect(cmdWrite).toBeTruthy()
    expect(cmdWrite![0].data).toContain('--session-id')
    expect(cmdWrite![0].data).not.toContain('--resume')
  })
})
