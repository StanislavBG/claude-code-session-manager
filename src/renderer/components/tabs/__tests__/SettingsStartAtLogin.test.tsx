// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { SettingsStartAtLogin } from '../SettingsStartAtLogin'
import { useToast } from '../../../state/toast'

type Status = {
  supported: boolean
  enabled: boolean
  mechanism: 'electron-login-item' | 'xdg-autostart' | 'launch-agent' | null
  starts: 'npx' | 'app' | null
  entryPath: string | null
  reason: string | null
}

const mk = (o: Partial<Status> = {}): Status => ({
  supported: true,
  enabled: false,
  mechanism: 'xdg-autostart',
  starts: 'npx',
  entryPath: '/home/u/.config/autostart/claude-code-session-manager.desktop',
  reason: null,
  ...o,
})

let host: HTMLDivElement
let root: Root
let loginItem: { status: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> }

async function mount(status: Status, setEnabled?: ReturnType<typeof vi.fn>) {
  loginItem = {
    status: vi.fn().mockResolvedValue(status),
    setEnabled: setEnabled ?? vi.fn().mockResolvedValue({ ok: true, status: { ...status, enabled: !status.enabled } }),
  }
  ;(window as unknown as { api: unknown }).api = { loginItem }
  await act(async () => { root.render(createElement(SettingsStartAtLogin)) })
  await act(async () => {})
}

const sw = () => host.querySelector('[role="switch"]') as HTMLButtonElement
const section = () => host.querySelector('[data-testid="settings-start-at-login"]')
const desc = () => host.querySelector('[data-testid="start-at-login-desc"]')?.textContent ?? ''
const errors = () => useToast.getState().toasts.filter((t) => t.kind === 'error').map((t) => t.message)

beforeEach(() => {
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('SettingsStartAtLogin', () => {
  it('reads status on mount and shows the off state', async () => {
    await mount(mk({ enabled: false }))
    expect(loginItem.status).toHaveBeenCalledTimes(1)
    expect(section()).not.toBeNull()
    expect(section()!.textContent).toContain('Start at login')
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(sw().disabled).toBe(false)
  })

  it('shows the on state', async () => {
    await mount(mk({ enabled: true }))
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('describes the npx start as the newest release', async () => {
    await mount(mk({ starts: 'npx' }))
    expect(desc()).toContain('npx claude-code-session-manager@latest')
    expect(desc()).toContain('newest release')
  })

  it('describes the app start as the installed app', async () => {
    await mount(mk({ starts: 'app', mechanism: 'electron-login-item' }))
    expect(desc()).toContain('installed app')
    expect(desc()).not.toContain('npx')
  })

  it('disables the switch and shows the reason when unsupported', async () => {
    await mount(mk({ supported: false, starts: null, mechanism: null, reason: 'Not available in a dev build' }))
    expect(sw().disabled).toBe(true)
    expect(desc()).toContain('Not available in a dev build')
  })

  it('disables the switch while setEnabled runs, then shows the returned status', async () => {
    let resolve!: (v: unknown) => void
    const setEnabled = vi.fn(() => new Promise((r) => { resolve = r }))
    await mount(mk({ enabled: false }), setEnabled)
    await act(async () => { sw().click() })
    expect(setEnabled).toHaveBeenCalledWith(true)
    expect(sw().disabled).toBe(true)
    await act(async () => { resolve({ ok: true, status: mk({ enabled: true, starts: 'app' }) }) })
    expect(sw().disabled).toBe(false)
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(desc()).toContain('installed app')
  })

  it('an { ok: false } answer toasts the error and leaves the switch as it was', async () => {
    await mount(mk({ enabled: false }), vi.fn().mockResolvedValue({ ok: false, error: 'autostart dir not writable' }))
    await act(async () => { sw().click() })
    await act(async () => {})
    expect(errors()).toContain('autostart dir not writable')
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(sw().disabled).toBe(false)
  })

  it('a thrown error toasts the message and leaves the switch as it was', async () => {
    await mount(mk({ enabled: true }), vi.fn().mockRejectedValue(new Error('ipc gone')))
    await act(async () => { sw().click() })
    await act(async () => {})
    expect(errors()).toContain('ipc gone')
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })
})
