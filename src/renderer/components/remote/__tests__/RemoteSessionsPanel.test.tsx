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

async function mount(props: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(RemoteSessionsPanel, { peerId: 'p1', machineName: 'Win-PC', ...props })) })
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
const LIST = {
  sessions: [
    { kind: 'epic', tabId: 'e2', epicId: 'E2', cwd: '/w/zed', title: 'Zed epic', project: 'zed', tag: 'build' },
    { kind: 'project', tabId: 'pz', cwd: '/w/zed', title: 'zed', project: 'zed' },
    { kind: 'epic', tabId: 'e1', epicId: 'E1', cwd: '/w/alpha', title: 'Alpha epic', project: 'alpha', tag: 'fix' },
    { kind: 'project', tabId: 'pa', cwd: '/w/alpha', title: 'alpha', project: 'alpha' },
  ],
}
function mockListThenSend() {
  send.mockImplementation(async (_p: string, cmd: string) => (cmd === 'cmd:sessions:list' ? LIST : { ok: true }))
}

describe('RemoteSessionsPanel', () => {
  it('groups by project (sorted), project row first, epics under the right project', async () => {
    mockListThenSend()
    await mount()
    expect(send).toHaveBeenCalledWith('p1', 'cmd:sessions:list', {})
    const groups = [...container!.querySelectorAll('[data-testid="remote-sessions-group"]')]
    expect(groups).toHaveLength(2)
    const ids = (g: Element) => [...g.querySelectorAll('[data-testid^="remote-session-select-"]')].map((e) => e.getAttribute('data-testid'))
    expect(ids(groups[0])).toEqual(['remote-session-select-pa', 'remote-session-select-e1'])
    expect(ids(groups[1])).toEqual(['remote-session-select-pz', 'remote-session-select-e2'])
    expect(groups[0].textContent).toContain('Alpha epic')
    expect(groups[0].textContent).toContain('fix')
    expect(q('remote-sessions-badge')!.textContent).toBe('Remote: Win-PC')
  })

  it('sends chat to the selected epic tabId', async () => {
    mockListThenSend()
    await mount()
    await click(q('remote-session-select-e1'))
    await typePrompt('hi')
    await click(q('remote-sessions-send'))
    expect(send).toHaveBeenLastCalledWith('p1', 'cmd:chat:send', { tabId: 'e1', prompt: 'hi' })
  })

  it('falls back to cmd:sessions:load tabs as project rows', async () => {
    send.mockImplementation(async (_p: string, cmd: string) => {
      if (cmd === 'cmd:sessions:list') throw new Error('unknown command')
      return TABS
    })
    await mount()
    expect(send).toHaveBeenCalledWith('p1', 'cmd:sessions:load', {})
    expect(q('remote-session-s1')!.textContent).toContain('Alpha')
    expect(q('remote-session-s1')!.textContent).toContain('/proj/a')
    expect(container!.querySelectorAll('[data-testid="remote-sessions-group"]')).toHaveLength(2)
    expect(useToast.getState().toasts).toHaveLength(0)
  })

  it('shows Terminal here on project rows only when onOpenTerminal is provided', async () => {
    mockListThenSend()
    const onOpenTerminal = vi.fn()
    await mount({ onOpenTerminal })
    expect(q('remote-session-terminal-pa')).not.toBeNull()
    expect(q('remote-session-terminal-e1')).toBeNull()
    await click(q('remote-session-terminal-pz'))
    expect(onOpenTerminal).toHaveBeenCalledWith('/w/zed')
  })

  it('renders no terminal button without onOpenTerminal', async () => {
    mockListThenSend()
    await mount()
    expect(q('remote-session-terminal-pa')).toBeNull()
  })

  it('shows the empty state', async () => {
    send.mockResolvedValue({ sessions: [] })
    await mount()
    expect(q('remote-sessions-empty')!.textContent).toBe('No sessions open on Win-PC.')
  })

  it('empty prompt is disabled until a row is selected and text typed', async () => {
    mockListThenSend()
    await mount()
    expect((q('remote-sessions-send') as HTMLButtonElement).disabled).toBe(true)
    await click(q('remote-session-select-pz'))
    expect((q('remote-sessions-send') as HTMLButtonElement).disabled).toBe(true)
    await typePrompt('hello')
    expect((q('remote-sessions-send') as HTMLButtonElement).disabled).toBe(false)
  })

  it('toasts an error when both loads fail', async () => {
    send.mockRejectedValue(new Error('boom'))
    await mount()
    expect(q('remote-sessions-error')).not.toBeNull()
    const t = useToast.getState().toasts
    expect(t[0].kind).toBe('error')
    expect(t[0].message).toContain('boom')
  })
})
