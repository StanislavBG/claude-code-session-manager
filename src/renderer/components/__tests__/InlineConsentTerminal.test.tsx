// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../testUtils/domFlush'
import { hasConsentGranted } from '../InlineConsentTerminal'

/**
 * InlineConsentTerminal — the short-lived inline PTY widget for granting MCP
 * consent without a full-screen wakeTab() mode switch. @xterm/xterm needs
 * matchMedia/canvas that plain jsdom doesn't provide, so both xterm packages
 * are stubbed with a minimal fake, same pattern as EpicTerminalPane.test.tsx.
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
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: { exists: vi.fn().mockResolvedValue(true) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, spawn, write, kill, resize, fireData: (data: string) => dataHandler?.(data), fireExit: (info: { exitCode: number | null }) => exitHandler?.(info) }
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

describe('hasConsentGranted', () => {
  it('detects known success phrasing case-insensitively', () => {
    expect(hasConsentGranted('Consent granted for claude_design.')).toBe(true)
    expect(hasConsentGranted('ACCESS GRANTED — you can now proceed')).toBe(true)
    expect(hasConsentGranted("You've granted this tool access.")).toBe(true)
  })

  it('does not match denial phrasing or unrelated output', () => {
    expect(hasConsentGranted("The user hasn't granted this — run /design consent to grant it")).toBe(false)
    expect(hasConsentGranted('this MCP server requires consent')).toBe(false)
    expect(hasConsentGranted('$ ls -la')).toBe(false)
    expect(hasConsentGranted('')).toBe(false)
  })
})

describe('InlineConsentTerminal', () => {
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

  it('spawns the pty keyed by sessionId in the given cwd', async () => {
    const { spawn } = installWindowApiMock()
    const { InlineConsentTerminal } = await import('../InlineConsentTerminal')

    mount(
      createElement(InlineConsentTerminal, {
        sessionId: 'claude-session-abc',
        cwd: '/proj',
        command: '/design consent',
        onGranted: () => {},
        onClose: () => {},
      }),
    )

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'claude-session-abc', cwd: '/proj' }))
  })

  it('auto-types the command after spawning when a transcript already exists', async () => {
    const { write } = installWindowApiMock()
    const { InlineConsentTerminal } = await import('../InlineConsentTerminal')

    mount(
      createElement(InlineConsentTerminal, {
        sessionId: 'claude-session-abc',
        cwd: '/proj',
        command: '/design consent',
        onGranted: () => {},
        onClose: () => {},
      }),
    )

    await flushAsync(2)
    act(() => { vi.advanceTimersByTime(1600) })

    const cmdWrite = write.mock.calls.find(([payload]) => payload.data.includes('/design consent'))
    expect(cmdWrite).toBeTruthy()
    expect(cmdWrite![0].tabId).toBe('claude-session-abc')
  })

  it('does not auto-type when no transcript exists yet (no live claude REPL to send to)', async () => {
    const { write } = installWindowApiMock()
    const fullApi = window.api as unknown as Record<string, unknown>
    Object.assign(fullApi, { config: { exists: vi.fn().mockResolvedValue(false) } })
    const { InlineConsentTerminal } = await import('../InlineConsentTerminal')

    mount(
      createElement(InlineConsentTerminal, {
        sessionId: 'claude-session-new',
        cwd: '/proj',
        command: '/design consent',
        onGranted: () => {},
        onClose: () => {},
      }),
    )

    await flushAsync(3)
    act(() => { vi.advanceTimersByTime(1600) })

    const cmdWrite = write.mock.calls.find(([payload]) => payload.data.includes('/design consent'))
    expect(cmdWrite).toBeUndefined()
  })

  it('PRD reattach guard: reattaching to a surviving pty never re-types the command', async () => {
    const { spawn, write } = installWindowApiMock()
    spawn.mockResolvedValue({ pid: 123, cwd: '/proj', reattached: true })
    const { InlineConsentTerminal } = await import('../InlineConsentTerminal')

    mount(
      createElement(InlineConsentTerminal, {
        sessionId: 'claude-session-abc',
        cwd: '/proj',
        command: '/design consent',
        onGranted: () => {},
        onClose: () => {},
      }),
    )

    await flushAsync(2)
    act(() => { vi.advanceTimersByTime(2000) })

    const cmdWrite = write.mock.calls.find(([payload]) => payload.data.includes('/design consent'))
    expect(cmdWrite).toBeUndefined()
  })

  it('calls onGranted once when pty output contains a consent-granted marker', async () => {
    const { fireData } = installWindowApiMock()
    const { InlineConsentTerminal } = await import('../InlineConsentTerminal')
    const onGranted = vi.fn()

    mount(
      createElement(InlineConsentTerminal, {
        sessionId: 'claude-session-abc',
        cwd: '/proj',
        command: '/design consent',
        onGranted,
        onClose: () => {},
      }),
    )

    await flushAsync(1)
    act(() => { fireData('Access granted for claude_design.\r\n') })
    act(() => { fireData('Access granted for claude_design.\r\n') })

    expect(onGranted).toHaveBeenCalledTimes(1)
  })

  it('Close control calls onClose and leaves the pty running (no kill)', async () => {
    const { kill } = installWindowApiMock()
    const { InlineConsentTerminal } = await import('../InlineConsentTerminal')
    const onClose = vi.fn()

    const el = mount(
      createElement(InlineConsentTerminal, {
        sessionId: 'claude-session-abc',
        cwd: '/proj',
        command: '/design consent',
        onGranted: () => {},
        onClose,
      }),
    )
    await flushAsync(1)

    const closeBtn = el.querySelector('[data-testid="inline-consent-terminal-close"]') as HTMLButtonElement
    act(() => { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(kill).not.toHaveBeenCalled()
  })

  it('unmounting disposes the xterm view but never calls pty.kill', async () => {
    const { kill } = installWindowApiMock()
    const { InlineConsentTerminal } = await import('../InlineConsentTerminal')

    mount(
      createElement(InlineConsentTerminal, {
        sessionId: 'claude-session-abc',
        cwd: '/proj',
        command: '/design consent',
        onGranted: () => {},
        onClose: () => {},
      }),
    )
    await flushAsync(1)

    act(() => root?.unmount())
    root = null

    expect(kill).not.toHaveBeenCalled()
  })
})
