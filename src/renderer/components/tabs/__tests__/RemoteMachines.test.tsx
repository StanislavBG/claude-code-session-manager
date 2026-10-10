// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../../remote/RemoteSessionsPanel', () => ({
  RemoteSessionsPanel: (p: { peerId: string; onOpenTerminal?: (c: string) => void }) =>
    createElement('button', { 'data-testid': 'stub-sessions', onClick: () => p.onOpenTerminal?.('/w') }, `sessions:${p.peerId}`),
}))
vi.mock('../../remote/RemoteTerminalPanel', () => ({
  RemoteTerminalPanel: (p: { peerId: string; cwd: string; onClose: () => void }) =>
    createElement('button', { 'data-testid': 'stub-terminal', onClick: p.onClose }, `terminal:${p.peerId}:${p.cwd}`),
}))

import { RemoteMachines } from '../RemoteMachines'
import { useToast } from '../../../state/toast'
import type { RemoteMachinePeer } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null
let peers: RemoteMachinePeer[]
let api: Record<string, ReturnType<typeof vi.fn>>
const onOpenSettings = vi.fn()

const peer = (o: Partial<RemoteMachinePeer> = {}): RemoteMachinePeer => ({
  peerId: 'p1', deviceId: 'd1', machineName: 'Win-PC', pairedAt: '2026-10-01T00:00:00Z',
  clientPublicKey: 'k', verifiedDevicePubKey: null, os: null, status: 'authenticated', reason: null, sas: null, ...o,
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(RemoteMachines, { onOpenSettings })); await Promise.resolve() })
}
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (el: HTMLElement | null) => {
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}

beforeEach(() => {
  peers = []
  api = {
    list: vi.fn(async () => peers),
    connect: vi.fn(async () => ({ status: 'connecting', reason: null, sas: null })),
    confirmSas: vi.fn(async () => ({ ok: true })),
    onStatus: vi.fn(() => vi.fn()),
  }
  ;(window as unknown as { api: unknown }).api = { remoteClient: api }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

describe('RemoteMachines', () => {
  it('shows empty state and routes to settings', async () => {
    await mount()
    expect(q('remote-view-empty')).not.toBeNull()
    await click(q('remote-view-open-settings'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('maps OS labels', async () => {
    peers = [
      peer({ peerId: 'a', os: 'win32' }), peer({ peerId: 'b', os: 'darwin' }),
      peer({ peerId: 'c', os: 'linux' }), peer({ peerId: 'd', os: null }),
    ]
    await mount()
    const rows = [...container!.querySelectorAll('[data-testid="remote-view-machine"]')].map((r) => r.textContent)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('Windows')
    expect(rows[1]).toContain('macOS')
    expect(rows[2]).toContain('Linux')
    expect(rows[3]).toContain('OS unknown')
  })

  it('renders offline vs online machines', async () => {
    peers = [peer({ status: 'disconnected' }), peer({ peerId: 'p2', machineName: 'Mac', status: 'authenticated' })]
    await mount()
    const rows = container!.querySelectorAll('[data-testid="remote-view-machine"]')
    expect(rows[0].textContent).toContain('offline')
    expect(rows[1].textContent).toContain('online')
    expect(q('remote-view-offline')).not.toBeNull()
    expect(q('remote-view-tab-sessions')).toBeNull()
    await click(q('remote-view-connect'))
    expect(api.connect).toHaveBeenCalledWith('p1')
    await click(rows[1] as HTMLElement)
    expect(q('remote-view-offline')).toBeNull()
    expect(q('stub-sessions')).not.toBeNull()
  })

  it('badges header and tabs with the selected machine and switches', async () => {
    peers = [peer(), peer({ peerId: 'p2', machineName: 'Mac' })]
    await mount()
    expect(q('remote-view-header-badge')!.textContent).toBe('Remote: Win-PC')
    expect(q('remote-view-tab-sessions')!.textContent).toContain('Remote: Win-PC')
    expect(q('remote-view-tab-terminal')!.textContent).toContain('Remote: Win-PC')
    await click(container!.querySelectorAll('[data-testid="remote-view-machine"]')[1] as HTMLElement)
    expect(q('remote-view-header-badge')!.textContent).toBe('Remote: Mac')
    expect(q('remote-view-tab-terminal')!.textContent).toContain('Remote: Mac')
  })

  it('opens terminal from sessions with cwd and closes back', async () => {
    peers = [peer()]
    await mount()
    await click(q('stub-sessions'))
    expect(q('stub-terminal')!.textContent).toBe('terminal:p1:/w')
    await click(q('stub-terminal'))
    expect(q('stub-sessions')).not.toBeNull()
  })
})
