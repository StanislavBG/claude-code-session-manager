// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { Terminal } from '../Terminal'
import { useSessions } from '../../state/sessions'

/**
 * Terminal.tsx's dormant-vs-running branch — retiring TerminalChat in favor
 * of EpicsWorkspace (see EpicsWorkspace.test.tsx for the cwd-scoping /
 * preselect behavior itself). EpicsWorkspace is stubbed here so this stays a
 * unit test of the branch, not a re-test of the workspace's own internals.
 */

vi.mock('../epics/EpicsWorkspace', () => ({
  EpicsWorkspace: (props: { cwd?: string }) =>
    createElement('div', { 'data-testid': 'stub-epics-workspace', 'data-cwd': props.cwd ?? '' }),
}))

vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    buffer = { active: { getLine: () => null } }
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    getSelection = vi.fn(() => '')
    clearSelection = vi.fn()
    registerLinkProvider = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
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
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

class FakeResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

function installWindowApiMock() {
  const api = {
    pty: {
      spawn: vi.fn().mockResolvedValue({ pid: 1, reattached: false }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    },
    shell: { open: vi.fn().mockResolvedValue(undefined) },
    clipboard: { pasteImage: vi.fn(), pasteText: vi.fn() },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
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

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useSessions.setState({ tabs: [], activeTabId: null })
  delete (window as unknown as { api?: unknown }).api
})

describe('Terminal — dormant tab renders EpicsWorkspace', () => {
  it('a dormant tab renders EpicsWorkspace scoped to its own cwd instead of the legacy chat surface', () => {
    installWindowApiMock()
    useSessions.setState({
      tabs: [{ id: 'tab-1', sessionId: 'tab-1', label: 'proj', cwd: '/home/bilko/Projects/alpha', status: 'dormant' } as any],
      activeTabId: 'tab-1',
    })

    const el = mount(createElement(Terminal, { tabId: 'tab-1', cwd: '/home/bilko/Projects/alpha' }))
    const stub = el.querySelector('[data-testid="stub-epics-workspace"]')
    expect(stub).not.toBeNull()
    expect(stub!.getAttribute('data-cwd')).toBe('/home/bilko/Projects/alpha')
  })

  it('a running tab does not render EpicsWorkspace (live PTY view instead)', () => {
    installWindowApiMock()
    useSessions.setState({
      tabs: [{ id: 'tab-2', sessionId: 'tab-2', label: 'proj', cwd: '/home/bilko/Projects/alpha', status: 'running' } as any],
      activeTabId: 'tab-2',
    })

    const el = mount(createElement(Terminal, { tabId: 'tab-2', cwd: '/home/bilko/Projects/alpha' }))
    expect(el.querySelector('[data-testid="stub-epics-workspace"]')).toBeNull()
    expect(el.textContent).toContain('Back to chat')
  })
})
