// @vitest-environment jsdom
/**
 * SessionActionsBar "Purge" — shown only for a completed Epic; the purge IPC
 * (epic:purge) fires only after the human types the Epic id; toasts the result.
 * Opening the confirm runs a read-only dry run (dryRun: true) whose artifact
 * count is shown, and confirm stays disabled until that count arrives.
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
const DRY = {
  ok: true, dryRun: true, removed: [], total: 4,
  artifacts: [],
  counts: { 'cli-transcript': 2, 'run-log': 1, 'epic-json': 1, 'history-rows': 0 },
}
/** Dry runs answer DRY; a real purge answers `real` (value, or a thrown error). */
function answer(real: unknown, dry: unknown = DRY) {
  purge.mockImplementation(async (p: { dryRun?: boolean }) => {
    const v = p.dryRun ? dry : real
    if (v instanceof Error) throw v
    return v
  })
}
const realCalls = () => purge.mock.calls.filter(([p]) => !p.dryRun)
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
  answer({ ok: true, dryRun: false, removed: ['/x'], artifacts: [], counts: {}, total: 1 })
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
    expect(purge).toHaveBeenCalledTimes(1)
    expect(purge).toHaveBeenCalledWith({ cwd: CWD, epicId: EPIC, dryRun: true })
    const input = q(el, 'epic-purge-input') as HTMLInputElement
    const confirm = q(el, 'epic-purge-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    typeInto(input, 'epic-')
    expect(confirm.disabled).toBe(true)
    await act(async () => { confirm.click() })
    expect(realCalls()).toHaveLength(0)
    typeInto(input, EPIC)
    expect(confirm.disabled).toBe(false)
  })

  it('cancel closes the confirm without purging', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    await act(async () => { (q(el, 'epic-purge-cancel') as HTMLButtonElement).click() })
    expect(q(el, 'epic-purge-input')).toBeNull()
    expect(realCalls()).toHaveLength(0)
  })

  it('calls epic:purge with cwd + id, toasts success and drops the Epic from the store', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    await act(async () => { (q(el, 'epic-purge-confirm') as HTMLButtonElement).click() })
    expect(realCalls()).toEqual([[{ cwd: CWD, epicId: EPIC }]])
    expect(showSpy).toHaveBeenCalledWith('info', expect.stringMatching(/purged/i))
    expect(usePromptSessions.getState().sessions[EPIC]).toBeUndefined()
  })

  it('toasts a refusal and keeps the Epic', async () => {
    answer({ ok: false, code: 'epic_running', error: 'has a running job' })
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    await act(async () => { (q(el, 'epic-purge-confirm') as HTMLButtonElement).click() })
    expect(showSpy).toHaveBeenCalledWith('error', 'has a running job')
    expect(usePromptSessions.getState().sessions[EPIC]).toBeDefined()
  })

  it('toasts a thrown IPC error', async () => {
    answer(new Error('ipc exploded'))
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    await act(async () => { (q(el, 'epic-purge-confirm') as HTMLButtonElement).click() })
    expect(showSpy).toHaveBeenCalledWith('error', 'ipc exploded')
  })

  it('shows the dry-run artifact count in the confirm before the human confirms', async () => {
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    const count = q(el, 'epic-purge-count')!
    expect(count.textContent).toBe('4 artifacts will be deleted (2 transcripts, 1 run log, 1 session file).')
    expect(realCalls()).toHaveLength(0)
  })

  it('keeps confirm disabled until the dry-run count arrives', async () => {
    let release: (v: unknown) => void = () => {}
    purge.mockImplementation((p: { dryRun?: boolean }) =>
      p.dryRun ? new Promise((r) => { release = r }) : Promise.resolve({ ok: true, dryRun: false, removed: [], artifacts: [], counts: {}, total: 0 }))
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    expect(q(el, 'epic-purge-count')!.textContent).toMatch(/counting/i)
    expect((q(el, 'epic-purge-confirm') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { release(DRY) })
    expect((q(el, 'epic-purge-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('a refused dry run shows the error, toasts it and keeps confirm disabled', async () => {
    answer({ ok: true }, { ok: false, code: 'epic_running', error: 'has a running job' })
    const el = await mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} epicId={EPIC} />)
    await act(async () => { (q(el, 'epic-purge') as HTMLButtonElement).click() })
    typeInto(q(el, 'epic-purge-input') as HTMLInputElement, EPIC)
    expect(q(el, 'epic-purge-count')!.textContent).toMatch(/has a running job/)
    expect(showSpy).toHaveBeenCalledWith('error', 'has a running job')
    expect((q(el, 'epic-purge-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(realCalls()).toHaveLength(0)
  })
})
