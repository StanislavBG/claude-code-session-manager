// @vitest-environment jsdom
/**
 * SessionActionsBar — hot-key strip: "+ New Session", project Macros, "New Macro",
 * and the manage panel. Launching a Macro goes through the same
 * mint -> approve -> send path the New Session card uses.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SessionActionsBar } from '../SessionActionsBar'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useChat } from '../../../state/chat'
import { toast } from '../../../state/toast'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'
import type { AgentPersona, Macro } from '../../../../preload/api'

const CWD = '/home/bilko/Projects/alpha'
const OTHER = '/home/bilko/Projects/beta'

function persona(over: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: 'scout', description: 'Looks around.', tools: [], model: null, effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null, path: '', body: '', overridingProjects: [], ...over,
  }
}
function macro(over: Partial<Macro> = {}): Macro {
  return {
    id: 'm1', label: 'Sweep', agentName: 'scout', tag: 'bug', prompt: 'Sweep it.\nSecond line', projects: [CWD],
    createdAt: '', updatedAt: '', ...over,
  }
}

let library: Macro[] = []
let changed: (() => void) | null = null
const listPersonas = vi.fn(async (): Promise<AgentPersona[]> => [persona({ tags: ['bug', 'feature'] }), persona({ name: 'other', tags: ['discussion'] })])
const save = vi.fn(async (i: any) => macro({ ...i, id: i.id ?? 'new1' }))
const setProject = vi.fn(async () => ({ ok: true as const, macro: macro() }))
const del = vi.fn(async () => undefined)
const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const approveProposedSpy = vi.fn()
const sendSpy = vi.fn()

;(globalThis as any).window.api = {
  agents: { listPersonas, onChanged: vi.fn(() => () => {}) },
  macros: {
    list: vi.fn(async () => library),
    save, setProject, delete: del,
    onChanged: vi.fn((h: () => void) => { changed = h; return () => { changed = null } }),
  },
  promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(el) })
  return container
}
const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const qa = (el: HTMLElement, id: string) => Array.from(el.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  library = []
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy, approveProposed: approveProposedSpy })
  createPromptSessionSpy.mockClear(); approveProposedSpy.mockClear(); sendSpy.mockClear()
  save.mockClear(); setProject.mockClear(); del.mockClear()
  useChat.setState({ send: sendSpy })
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: CWD } as any], activeTabId: 'tab-1' })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('SessionActionsBar', () => {
  it('fresh install: exactly "+ New Session" and "New Macro", no manage button', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    const labels = Array.from(el.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['+ New Session', 'New Macro'])
    expect(q(el, 'hotkey-manage')).toBeNull()
  })

  it('+ New Session calls onNew', async () => {
    const onNew = vi.fn()
    const el = await mount(<SessionActionsBar onNew={onNew} onSelect={vi.fn()} />)
    act(() => q(el, 'epic-queue-new')!.click())
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('disables New Macro without an active project', async () => {
    useSessions.setState({ tabs: [], activeTabId: null } as any)
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    expect((q(el, 'hotkey-new-macro') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows this project\'s and "*" macros, not other projects\'', async () => {
    library = [macro({ id: 'a', label: 'Mine' }), macro({ id: 'b', label: 'Theirs', projects: [OTHER] }), macro({ id: 'c', label: 'Everywhere', projects: ['*'] })]
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    expect(qa(el, 'hotkey-macro').map((b) => b.textContent)).toEqual(['Everywhere', 'Mine'])
    expect(q(el, 'hotkey-manage')).not.toBeNull()
    expect(qa(el, 'hotkey-macro')[1].title).toBe('Start a new bug session as "scout": Sweep it.')
  })

  it('clicking a macro mints + approves + sends with its agent, tag and prompt', async () => {
    library = [macro()]
    const onSelect = vi.fn()
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={onSelect} />)
    await act(async () => { qa(el, 'hotkey-macro')[0].click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [cwd, , tag, , agentType, openingPrompt] = createPromptSessionSpy.mock.calls[0]
    expect(cwd).toBe(CWD)
    expect(tag).toBe('bug')
    expect(agentType).toBe('scout')
    expect(openingPrompt).toContain('You are acting as the "scout" agent')
    expect(openingPrompt).toContain('Sweep it.')
    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id, 'SessionActionsBar scout')
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ tabId: created.id, cwd: CWD, prompt: expect.stringContaining('Sweep it.') }))
    expect(onSelect).toHaveBeenCalledWith(created.id)
  })

  it('New Macro -> fill -> Save calls macros.save with projects [cwd]; button appears after macros:changed', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    act(() => q(el, 'hotkey-new-macro')!.click())
    expect(q(el, 'macro-editor')).not.toBeNull()
    act(() => {
      setValue(q(el, 'macro-label') as HTMLInputElement, 'Scan')
      setValue(q(el, 'macro-prompt') as HTMLTextAreaElement, 'Scan everything')
    })
    await act(async () => { q(el, 'macro-save')!.click() })
    expect(save).toHaveBeenCalledWith({ label: 'Scan', agentName: 'scout', tag: 'bug', prompt: 'Scan everything', projects: [CWD] })
    expect(q(el, 'macro-editor')).toBeNull()

    library = [macro({ id: 'new1', label: 'Scan' })]
    await act(async () => { changed?.() })
    expect(qa(el, 'hotkey-macro').map((b) => b.textContent)).toEqual(['Scan'])
  })

  it('blocks Save with empty label or prompt', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    act(() => q(el, 'hotkey-new-macro')!.click())
    const btn = q(el, 'macro-save') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    act(() => setValue(q(el, 'macro-label') as HTMLInputElement, 'X'))
    expect(btn.disabled).toBe(true)
    act(() => setValue(q(el, 'macro-prompt') as HTMLTextAreaElement, 'Y'))
    expect(btn.disabled).toBe(false)
  })

  it('manage toggle calls setProject', async () => {
    library = [macro({ projects: [OTHER] })]
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    act(() => q(el, 'hotkey-manage')!.click())
    const toggle = q(el, 'hotkey-manage-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await act(async () => { toggle.click() })
    expect(setProject).toHaveBeenCalledWith({ id: 'm1', cwd: CWD, enabled: true })
  })

  it('"*" macros are checked and disabled in the manage panel', async () => {
    library = [macro({ projects: ['*'] })]
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    act(() => q(el, 'hotkey-manage')!.click())
    const toggle = q(el, 'hotkey-manage-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)
    expect(q(el, 'hotkey-manage-panel')!.textContent).toContain('every project')
  })

  it('delete requires a confirm step', async () => {
    library = [macro()]
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    act(() => q(el, 'hotkey-manage')!.click())
    act(() => q(el, 'hotkey-delete')!.click())
    expect(del).not.toHaveBeenCalled()
    act(() => q(el, 'hotkey-delete-no')!.click())
    expect(del).not.toHaveBeenCalled()
    act(() => q(el, 'hotkey-delete')!.click())
    await act(async () => { q(el, 'hotkey-delete-yes')!.click() })
    expect(del).toHaveBeenCalledWith({ id: 'm1' })
  })

  it('edit prefills and preserves the id and projects', async () => {
    library = [macro({ id: 'keep', label: 'Old', projects: [CWD, OTHER] })]
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    act(() => q(el, 'hotkey-manage')!.click())
    act(() => q(el, 'hotkey-edit')!.click())
    expect((q(el, 'macro-label') as HTMLInputElement).value).toBe('Old')
    act(() => setValue(q(el, 'macro-label') as HTMLInputElement, 'Renamed'))
    await act(async () => { q(el, 'macro-save')!.click() })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'keep', label: 'Renamed', projects: [CWD, OTHER] }))
  })

  it('launching a macro whose agent is gone toasts and mints nothing', async () => {
    library = [macro({ agentName: 'ghost' })]
    const errSpy = vi.spyOn(toast, 'error')
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    await act(async () => { qa(el, 'hotkey-macro')[0].click() })
    expect(errSpy).toHaveBeenCalledWith('Agent ghost not found \u2014 edit the macro')
    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('a manage toggle made while the editor is open is not reverted by Save', async () => {
    library = [macro({ id: 'k', projects: [CWD] })]
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    act(() => q(el, 'hotkey-manage')!.click())
    act(() => q(el, 'hotkey-edit')!.click())
    // Another surface adds OTHER while the editor holds its CWD-only snapshot.
    library = [macro({ id: 'k', projects: [CWD, OTHER] })]
    await act(async () => { changed?.() })
    await act(async () => { q(el, 'macro-save')!.click() })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'k', projects: [CWD, OTHER] }))
  })
})
