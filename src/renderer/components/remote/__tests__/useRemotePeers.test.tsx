// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useRemotePeers, type RemotePeers } from '../useRemotePeers'
import { useToast } from '../../../state/toast'
import type { RemoteMachinePeer } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null
let hook: RemotePeers
let api: Record<string, ReturnType<typeof vi.fn>>
let statusHandler: (s: unknown) => void

const peer = (o: Partial<RemoteMachinePeer> = {}): RemoteMachinePeer => ({
  peerId: 'p1', deviceId: 'd1', machineName: 'Win-PC', pairedAt: '2026-10-01T00:00:00Z',
  clientPublicKey: 'k', verifiedDevicePubKey: null, os: null, status: 'disconnected', reason: null, sas: null, ...o,
})

function Probe() {
  hook = useRemotePeers()
  return null
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(Probe)); await Promise.resolve() })
}

beforeEach(() => {
  api = {
    list: vi.fn(async () => [peer(), peer({ peerId: 'p2', machineName: 'Mac' })]),
    connect: vi.fn(async () => ({ status: 'connecting', reason: null, sas: null })),
    confirmSas: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    onStatus: vi.fn((cb: (s: unknown) => void) => { statusHandler = cb; return vi.fn() }),
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

describe('useRemotePeers', () => {
  it('loads the peer list on mount', async () => {
    await mount()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(hook.peers.map((p) => p.peerId)).toEqual(['p1', 'p2'])
  })

  it('an onStatus event updates only the matching peer', async () => {
    await mount()
    await act(async () => { statusHandler({ peerId: 'p2', status: 'authenticated', reason: null, sas: null }); await Promise.resolve() })
    expect(hook.peers.find((p) => p.peerId === 'p2')!.status).toBe('authenticated')
    expect(hook.peers.find((p) => p.peerId === 'p1')!.status).toBe('disconnected')
  })

  it('connect failure shows an error toast', async () => {
    api.connect.mockImplementation(async () => { throw new Error('boom') })
    await mount()
    await act(async () => { await hook.connect('p1') })
    const toasts = useToast.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].message).toBe('boom')
  })

  it('revoke calls remove then refreshes', async () => {
    await mount()
    await act(async () => { await hook.revoke('p1') })
    expect(api.remove).toHaveBeenCalledWith('p1')
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(api.remove.mock.invocationCallOrder[0]).toBeLessThan(api.list.mock.invocationCallOrder[1])
  })
})
