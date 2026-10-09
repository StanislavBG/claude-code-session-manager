// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsRemote } from '../SettingsRemote'
import { useToast } from '../../../state/toast'
import type { WebRemoteStatus } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

const baseStatus: WebRemoteStatus = {
  enabled: false,
  remoteControlEnabled: false,
  connected: false,
  e2eActive: false,
  e2eAuthenticated: false,
  e2eState: 'idle',
  pendingSas: null,
  devices: [],
}

let status: WebRemoteStatus
let api: Record<string, ReturnType<typeof vi.fn>>
const unsubs = { status: vi.fn(), revoked: vi.fn(), revokedAll: vi.fn() }

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(SettingsRemote))
    await Promise.resolve()
  })
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (el: HTMLElement | null) => {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  status = { ...baseStatus }
  api = {
    getStatus: vi.fn(async () => status),
    enable: vi.fn(async () => ({ ok: true })),
    disable: vi.fn(async () => ({ ok: true })),
    enableControl: vi.fn(async () => ({ ok: true })),
    disableControl: vi.fn(async () => ({ ok: true })),
    pair: vi.fn(async () => ({ ok: true, deviceId: 'd1' })),
    revokeDevice: vi.fn(async () => ({ ok: true })),
    revokeAll: vi.fn(async () => ({ ok: true })),
    confirmSas: vi.fn(async () => ({ ok: true })),
    auditTail: vi.fn(async () => ({ ok: true, lines: [] })),
    onStatus: vi.fn(() => unsubs.status),
    onTokenRevoked: vi.fn(() => unsubs.revoked),
    onRevokedAll: vi.fn(() => unsubs.revokedAll),
  }
  ;(window as unknown as { api: unknown }).api = { webRemote: api }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

describe('SettingsRemote', () => {
  it('shows the master switch off when disabled and enables on click', async () => {
    await mount()
    const sw = q('settings-remote-enable')!.querySelector('[role="switch"]') as HTMLElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await click(sw)
    expect(api.enable).toHaveBeenCalledTimes(1)
  })

  it('submits the pairing code', async () => {
    await mount()
    await click(q('settings-remote-pair-start'))
    const input = q('settings-remote-otp') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'abcd1234')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(q('settings-remote-pair-confirm'))
    expect(api.pair).toHaveBeenCalledWith('ABCD1234')
  })

  it('confirms the SAS', async () => {
    status = { ...baseStatus, enabled: true, e2eActive: true, e2eState: 'pending_sas', pendingSas: '123456' }
    await mount()
    expect(q('settings-remote-sas-code')!.textContent).toBe('123456')
    await click(q('settings-remote-sas-confirm'))
    expect(api.confirmSas).toHaveBeenCalledTimes(1)
  })

  it('revokes a device by id', async () => {
    status = {
      ...baseStatus,
      enabled: true,
      devices: [{ deviceId: 'dev-42', deviceName: 'Phone', issuedAt: '2026-01-01T00:00:00Z', lastConnectedAt: null }],
    }
    await mount()
    await click(q('settings-remote-revoke'))
    expect(api.revokeDevice).toHaveBeenCalledWith('dev-42')
  })

  it('toggles remote control on and off', async () => {
    status = { ...baseStatus, enabled: true }
    await mount()
    const sw = () => q('settings-remote-control')!.querySelector('[role="switch"]') as HTMLElement
    api.enableControl.mockImplementationOnce(async () => {
      status = { ...baseStatus, enabled: true, remoteControlEnabled: true }
      return { ok: true }
    })
    await click(sw())
    await act(async () => { await Promise.resolve() })
    expect(api.enableControl).toHaveBeenCalledTimes(1)
    await click(sw())
    expect(api.disableControl).toHaveBeenCalledTimes(1)
  })

  it('toasts errors and unsubscribes on unmount', async () => {
    api.revokeAll.mockResolvedValueOnce({ ok: false, error: 'nope' })
    await mount()
    await click(q('settings-remote-revoke-all'))
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('nope'))).toBe(true)
    act(() => root?.unmount())
    expect(unsubs.status).toHaveBeenCalled()
    expect(unsubs.revoked).toHaveBeenCalled()
    expect(unsubs.revokedAll).toHaveBeenCalled()
    root = null
  })
})
