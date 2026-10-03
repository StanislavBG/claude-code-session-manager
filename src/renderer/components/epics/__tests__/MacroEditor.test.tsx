// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MacroEditor } from '../MacroEditor'
import type { AgentPersona, Macro } from '../../../../preload/api'

const CWD = '/p/alpha'
const agent = (name: string, tags: string[]): AgentPersona => ({
  name, description: null, tools: [], model: null, effort: null, color: null, tags: tags as any,
  projects: [], action: null, actionLabel: null, path: '', body: '', overridingProjects: [],
})
const agents = [agent('architect', ['feature', 'bug']), agent('builder', ['build'])]
const save = vi.fn()
;(globalThis as any).window.api = { macros: { save } }

let container: HTMLDivElement, root: Root
const onClose = vi.fn()
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement
function setValue(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function mount(props: Partial<React.ComponentProps<typeof MacroEditor>> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MacroEditor cwd={CWD} agents={agents} onClose={onClose} {...props} />))
}
beforeEach(() => { save.mockReset(); save.mockResolvedValue({}); onClose.mockClear() })
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('MacroEditor', () => {
  it('saves with the first agent, first tag and [cwd], then closes', async () => {
    mount()
    act(() => { setValue(q('macro-label') as HTMLInputElement, ' Go '); setValue(q('macro-prompt') as HTMLTextAreaElement, 'Do it') })
    await act(async () => { q('macro-save').click() })
    expect(save).toHaveBeenCalledWith({ label: 'Go', agentName: 'architect', tag: 'feature', prompt: 'Do it', projects: [CWD] })
    expect(onClose).toHaveBeenCalled()
  })

  it('"Show in every project" saves projects ["*"]', async () => {
    mount()
    act(() => { setValue(q('macro-label') as HTMLInputElement, 'a'); setValue(q('macro-prompt') as HTMLTextAreaElement, 'b'); q('macro-everywhere').click() })
    await act(async () => { q('macro-save').click() })
    expect(save.mock.calls[0][0].projects).toEqual(['*'])
  })

  it('shows the error inline and stays open when save throws', async () => {
    save.mockRejectedValue(new Error('label taken'))
    mount()
    act(() => { setValue(q('macro-label') as HTMLInputElement, 'a'); setValue(q('macro-prompt') as HTMLTextAreaElement, 'b') })
    await act(async () => { q('macro-save').click() })
    expect(q('macro-error').textContent).toBe('label taken')
    expect(onClose).not.toHaveBeenCalled()
  })

  const pressed = () => Array.from(container.querySelectorAll('[data-testid="macro-tag"]')).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-tag'))
  const mac = (over: Partial<Macro> = {}): Macro => ({ id: 'm', label: 'L', agentName: 'architect', tag: 'bug', prompt: 'p', projects: [CWD], surface: 'sessions', createdAt: '', updatedAt: '', ...over })
  function pickAgent(name: string) {
    const sel = q('new-epic-agent-select') as HTMLSelectElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, name)
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('keeps the tag on open, then snaps to the first allowed tag when the user changes agent', () => {
    mount({ macro: mac() })
    expect(pressed()).toEqual(['bug'])
    pickAgent('builder')
    expect(pressed()).toEqual(['build'])
  })

  it('keeps the tag when the user changes to an agent that still allows it', () => {
    mount({ macro: mac({ tag: 'bug' }) })
    pickAgent('architect')
    expect(pressed()).toEqual(['bug'])
  })

  it('missing agent: keeps the macro tag, shows a warning, saves the tag unchanged', async () => {
    mount({ macro: mac({ agentName: 'ghost', tag: 'build' }) })
    expect(pressed()).toEqual(['build'])
    expect(q('macro-agent-missing').textContent).toBe('agent ghost not found')
    await act(async () => { q('macro-save').click() })
    expect(save.mock.calls[0][0]).toEqual(expect.objectContaining({ agentName: 'ghost', tag: 'build' }))
  })

  it('personas still loading: no snap, no warning', () => {
    mount({ agents: [], macro: mac({ tag: 'build' }) })
    expect(pressed()).toEqual(['build'])
    expect(q('macro-agent-missing')).toBeNull()
  })

  it('editing a "*" macro and unticking "every project" saves [cwd]', async () => {
    mount({ macro: mac({ projects: ['*'] }) })
    expect((q('macro-everywhere') as HTMLInputElement).checked).toBe(true)
    act(() => q('macro-everywhere').click())
    await act(async () => { q('macro-save').click() })
    expect(save.mock.calls[0][0].projects).toEqual([CWD])
  })

  it('saves projects from the live library macro, not the stale snapshot', async () => {
    const stale = mac({ projects: [CWD] })
    mount({ macro: stale, latest: mac({ projects: [CWD, '/p/beta'] }) })
    await act(async () => { q('macro-save').click() })
    expect(save.mock.calls[0][0].projects).toEqual([CWD, '/p/beta'])
  })

  it('Cancel and Escape close without saving', () => {
    mount()
    act(() => q('macro-cancel').click())
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(save).not.toHaveBeenCalled()
  })
})
