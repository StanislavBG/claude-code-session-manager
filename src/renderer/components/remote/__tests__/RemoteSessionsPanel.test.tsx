// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RemoteSessionsPanel } from '../RemoteSessionsPanel'
import { useToast } from '../../../state/toast'

let container: HTMLDivElement | null = null
let root: Root | null = null
const send = vi.fn()

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(RemoteSessionsPanel, { peerId: 'p1', machineName: 'Win-PC' })) })
}
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (el: HTMLElement | null) => {
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
async function typePrompt(value: string) {
  const ta = q('remote-sessions-prompt') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  send.mockReset()
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  ;(window as unknown as { api: unknown }).api = { remoteClient: { send } }
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

const TABS = { tabs: [{ sessionId: 's1', cwd: '/proj/a', label: 'Alpha' }, { sessionId: 's2', cwd: '/proj/b' }], activeTabId: 's1' }

describe('RemoteSessionsPanel', () => {
  it('loads sessions on mount and renders title, cwd and machine badge', async () => {
    send.mockResolvedValue(TABS)
    await mount()
    expect(send).toHaveBeenCalledWith('p1', 'cmd:sessions:load', {})
    expect(q('remote-session-s1')!.textContent).toContain('Alpha')
    expect(q('remote-session-s1')!.textContent).toContain('/proj/a')
    expect(q('remote-sessions-badge')!.textContent).toBe('Remote: Win-PC')
  })

  it('shows the empty state', async () => {
    send.mockResolvedValue({ tabs: [] })
    await mount()
    expect(q('remote-sessions-empty')!.textContent).toBe('No sessions open on Win-PC.')
  })

  it('sends the chat payload for the selected session; empty prompt is disabled', async () => {
    send.mockResolvedValue(TABS)
    await mount()
    expect((q('remote-sessions-send') as HTMLButtonElement).disabled).toBe(true)
    await click(q('remote-session-select-s2'))
    expect((q('remote-sessions-send') as HTMLButtonElement).disabled).toBe(true)
    await typePrompt('hello')
    expect((q('remote-sessions-send') as HTMLButtonElement).disabled).toBe(false)
    send.mockResolvedValue({ ok: true })
    await click(q('remote-sessions-send'))
    expect(send).toHaveBeenLastCalledWith('p1', 'cmd:chat:send', { tabId: 's2', prompt: 'hello' })
  })

  it('toasts an error when loading fails', async () => {
    send.mockRejectedValue(new Error('boom'))
    await mount()
    expect(q('remote-sessions-error')).not.toBeNull()
    const t = useToast.getState().toasts
    expect(t[0].kind).toBe('error')
    expect(t[0].message).toContain('boom')
  })
})
