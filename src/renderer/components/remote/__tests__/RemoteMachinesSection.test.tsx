// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RemoteMachinesSection } from '../RemoteMachinesSection'
import { useToast } from '../../../state/toast'
import type { RemoteMachinePeer } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null
let peers: RemoteMachinePeer[]
const unsub = vi.fn()
let api: Record<string, ReturnType<typeof vi.fn>>

const peer = (o: Partial<RemoteMachinePeer> = {}): RemoteMachinePeer => ({
  peerId: 'p1', deviceId: 'd1', machineName: 'Win-PC', pairedAt: '2026-10-01T00:00:00Z',
  clientPublicKey: 'k', verifiedDevicePubKey: null, status: 'disconnected', reason: null, sas: null, ...o,
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(RemoteMachinesSection)); await Promise.resolve() })
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
    remove: vi.fn(async () => ({ ok: true })),
    send: vi.fn(async () => ({})),
    onStatus: vi.fn(() => unsub),
    onEvent: vi.fn(() => vi.fn()),
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

describe('RemoteMachinesSection', () => {
  it('lists paired machines with count and online badge', async () => {
    peers = [peer({ status: 'authenticated' }), peer({ peerId: 'p2', machineName: 'Mac' })]
    await mount()
    const rows = container!.querySelectorAll('[data-testid="remote-machine"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Win-PC')
    expect(rows[0].textContent).toContain('p1 · last seen')
    expect(rows[0].textContent).toContain('online')
    expect(rows[1].textContent).not.toContain('online')
    expect(container!.textContent).toContain('2 paired')
  })

  it('shows the empty state', async () => {
    await mount()
    expect(q('remote-machines-empty')!.textContent).toBe('No machines paired yet.')
  })

  it('confirms the SAS for the peer', async () => {
    peers = [peer({ status: 'pending_sas', sas: '654321' })]
    await mount()
    expect(q('remote-machine-sas')!.textContent).toContain('Compare this code with the other machine')
    await click(q('remote-machine-sas-confirm'))
    expect(api.confirmSas).toHaveBeenCalledWith('p1')
  })

  it('says the relay lacks desktop support and offers no Connect', async () => {
    peers = [peer({ status: 'failed', reason: 'relay_client_auth_unavailable' })]
    await mount()
    expect(q('remote-machine-unavailable')!.textContent).toBe('The bilko.run relay does not support desktop clients yet')
    expect(q('remote-machine-connect')).toBeNull()
  })

  it('connects and revokes', async () => {
    peers = [peer()]
    await mount()
    await click(q('remote-machine-connect'))
    expect(api.connect).toHaveBeenCalledWith('p1')
    await click(q('remote-machine-revoke'))
    expect(api.remove).toHaveBeenCalledWith('p1')
  })

  it('unsubscribes from status on unmount', async () => {
    await mount()
    expect(api.onStatus).toHaveBeenCalledTimes(1)
    act(() => root?.unmount())
    expect(unsub).toHaveBeenCalled()
    root = null
  })
})
