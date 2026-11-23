// @vitest-environment jsdom
/**
 * SessionActionsBar "Purge" — shown only for a completed Epic; the purge IPC
 * (epic:purge) fires only after the human types the Epic id; toasts the result.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SessionActionsBar } from '../SessionActionsBar'
import { __resetMacrosCacheForTests } from '../../../lib/useMacros'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useToast } from '../../../state/toast'

const CWD = '/home/bilko/Projects/alpha'
const EPIC = 'epic-1'

const purge = vi.fn()
;(globalThis as any).window.api = {
  agents: { listPersonas: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
  macros: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
  promptSessions: { purge, refreshAgentSnapshot: vi.fn(), onEventAppended: vi.fn() },
}

let container: HTMLDivElement | null = null
let root: Root | null = null
const showSpy = vi.fn()

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(el) })
  return container
}
const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

function setStatus(status: string) {
  usePromptSessions.setState({
    sessions: { [EPIC]: { id: EPIC, cwd: CWD, status } as any },
    events: { [EPIC]: [] },
  })
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  __resetMacrosCacheForTests()
  purge.mockReset()
  showSpy.mockReset()
  useToast.setState({ show: showSpy } as any)
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: CWD } as any], activeTabId: 'tab-1' })
  setStatus('completed')
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('SessionActionsBar — Purge', () => {
  it('is absent for active and proposed Epics, and with no Epic selected', async () => {
    for (const status of ['active', 'proposed']) {
      setStatus(status)
      const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
      expect(q(el, 'epic-purge')).toBeNull()
      act(() => root?.unmount())
      container?.remove()
    }
    setStatus('completed')
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    expect(q(el, 'epic-purge')).toBeNull()
  })

  it('requires typing the exact Epic id before the IPC can fire', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    const btn = q(el, 'epic-purge') as HTMLButtonElement
    expect(btn.textContent).toBe('Purge')
    await act(async () => { btn.click() })
    expect(purge).not.toHaveBeenCalled()
    const input = q(el, 'epic-purge-input') as HTMLInputElement
    const confirm = q(el, 'epic-purge-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    typeInto(input, 'epic-')
    expect(confirm.disabled).toBe(true)
    await act(async () => { confirm.click() })
    expect(purge).not.toHaveBeenCalled()
    typeInto(input, EPIC)
    expect(confirm.disabled).toBe(false)
  })

  it('cancel closes the confirm without purging', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    await act(async () => { (q(el, 'epic-purge-cancel') as HTMLButtonElement).click() })
    expect(q(el, 'epic-purge-input')).toBeNull()
    expect(purge).not.toHaveBeenCalled()
  })

  it('calls epic:purge with cwd + id, toasts success and drops the Epic from the store', async () => {
    purge.mockResolvedValue({ ok: true, removed: ['/x'] })
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    await act(async () => { (q(el, 'epic-purge-confirm') as HTMLButtonElement).click() })
    expect(purge).toHaveBeenCalledWith({ cwd: CWD, epicId: EPIC })
    expect(showSpy).toHaveBeenCalledWith('info', expect.stringMatching(/purged/i))
    expect(usePromptSessions.getState().sessions[EPIC]).toBeUndefined()
  })

  it('toasts a refusal and keeps the Epic', async () => {
    purge.mockResolvedValue({ ok: false, code: 'epic_running', error: 'has a running job' })
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    await act(async () => { (q(el, 'epic-purge-confirm') as HTMLButtonElement).click() })
    expect(showSpy).toHaveBeenCalledWith('error', 'has a running job')
    expect(usePromptSessions.getState().sessions[EPIC]).toBeDefined()
  })

  it('toasts a thrown IPC error', async () => {
    purge.mockRejectedValue(new Error('ipc exploded'))
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    await act(async () => { (q(el, 'epic-purge-confirm') as HTMLButtonElement).click() })
    expect(showSpy).toHaveBeenCalledWith('error', 'ipc exploded')
  })
})
