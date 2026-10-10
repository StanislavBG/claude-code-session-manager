// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const terms: any[] = []
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; options: Record<string, unknown> = {}
    write = vi.fn(); open = vi.fn(); focus = vi.fn(); dispose = vi.fn(); loadAddon = vi.fn()
    dataCb: ((d: string) => void) | null = null
    onData = (cb: (d: string) => void) => { this.dataCb = cb; return { dispose: vi.fn() } }
    onResize = vi.fn(() => ({ dispose: vi.fn() }))
    constructor() { terms.push(this) }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn() } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import { RemoteTerminalPanel } from '../RemoteTerminalPanel'

let container: HTMLDivElement | null = null
let root: Root | null = null
let handlers: Array<(ev: any) => void> = []
let unsubs: number
let send: ReturnType<typeof vi.fn>

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(RemoteTerminalPanel, { peerId: 'p1', machineName: 'win-box', cwd: '/w', onClose: vi.fn() }))
  })
}

beforeEach(() => {
  terms.length = 0
  handlers = []
  unsubs = 0
  send = vi.fn(() => Promise.resolve({}))
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
  ;(window as any).api = {
    remoteClient: {
      send,
      onEvent: (h: (ev: any) => void) => { handlers.push(h); return () => { unsubs++ } },
    },
  }
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  container?.remove(); container = null; root = null
})

const spawnTabId = () => send.mock.calls.find((c) => c[1] === 'cmd:pty:spawn')![2].tabId as string

describe('RemoteTerminalPanel', () => {
  it('spawns on mount and shows the machine badge', async () => {
    await mount()
    const spawn = send.mock.calls.find((c) => c[1] === 'cmd:pty:spawn')!
    expect(spawn[0]).toBe('p1')
    expect(spawn[2]).toMatchObject({ cwd: '/w', cols: 80, rows: 24 })
    expect(container!.querySelector('[data-testid="remote-terminal-badge"]')!.textContent).toBe('Remote: win-box')
  })

  it('writes matched events and ignores foreign ones', async () => {
    await mount()
    const tabId = spawnTabId()
    handlers[0]({ peerId: 'p1', type: 'event:pty:data', payload: { tabId, data: 'hello' } })
    handlers[0]({ peerId: 'p1', type: 'event:pty:data', payload: { tabId: 'other', data: 'nope' } })
    handlers[0]({ peerId: 'p2', type: 'event:pty:data', payload: { tabId, data: 'nope2' } })
    expect(terms[0].write).toHaveBeenCalledTimes(1)
    expect(terms[0].write).toHaveBeenCalledWith('hello')
  })

  it('forwards keystrokes and disables input after exit', async () => {
    await mount()
    const tabId = spawnTabId()
    terms[0].dataCb('x')
    expect(send).toHaveBeenCalledWith('p1', 'cmd:pty:write', { tabId, data: 'x' })
    await act(async () => { handlers[0]({ peerId: 'p1', type: 'event:pty:exit', payload: { tabId, exitCode: 0 } }) })
    send.mockClear()
    terms[0].dataCb('y')
    expect(send).not.toHaveBeenCalled()
  })

  it('kills and unsubscribes on unmount', async () => {
    await mount()
    const tabId = spawnTabId()
    await act(async () => { root!.unmount() }); root = null
    expect(send).toHaveBeenCalledWith('p1', 'cmd:pty:kill', { tabId })
    expect(unsubs).toBe(handlers.length)
    expect(terms[0].dispose).toHaveBeenCalled()
  })
})
