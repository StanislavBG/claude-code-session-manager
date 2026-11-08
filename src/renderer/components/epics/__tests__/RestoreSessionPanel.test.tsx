// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RestoreSessionPanel } from '../RestoreSessionPanel'
import { useToast } from '../../../state/toast'
import type { PromptSessionsListRestorableResult, RestorableSession } from '../../../../preload/api'

const CWD = '/home/bilko/Projects/alpha'
const ID_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ID_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ID_H1 = 'cccccccc-0000-4000-8000-00000000000c'
const ID_H2 = 'dddddddd-0000-4000-8000-00000000000d'

function session(sessionId: string, over: Partial<RestorableSession> = {}): RestorableSession {
  return {
    sessionId,
    title: null,
    firstPrompt: `First prompt of ${sessionId.slice(0, 8)}`,
    lastPrompt: null,
    gitBranch: null,
    headless: false,
    mtimeMs: Date.now() - 5 * 60_000,
    sizeBytes: 2048,
    recentlyActive: false,
    ...over,
  }
}

function result(sessions: RestorableSession[]): PromptSessionsListRestorableResult {
  return { sessions, hiddenClaimed: 0, scanned: sessions.length, truncated: false }
}

const listRestorable = vi.fn(async (_payload: { cwd: string }): Promise<PromptSessionsListRestorableResult> => result([]))

let container: HTMLDivElement | null = null
let root: Root | null = null

type PanelProps = ComponentProps<typeof RestoreSessionPanel>

/** Mounts on first call, re-renders the same root afterwards (so cwd/props changes are real updates). */
function render(props: Partial<PanelProps> = {}) {
  const full: PanelProps = { cwd: CWD, excludeIds: [], selectedId: null, onSelect: vi.fn(), ...props }
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(<RestoreSessionPanel {...full} />))
  return container
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)
const radio = (el: HTMLElement, id: string) => q(el, `restore-session-option-${id}`) as HTMLInputElement | null
const rowText = (el: HTMLElement, id: string) => radio(el, id)?.closest('label')?.textContent ?? ''
const flush = () => act(async () => {})
const setApi = (api: unknown) => { (window as unknown as { api: unknown }).api = api }

beforeEach(() => {
  useToast.setState({ toasts: [], history: [] } as never)
  listRestorable.mockClear()
  listRestorable.mockImplementation(async () => result([]))
  setApi({ promptSessions: { listRestorable } })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('RestoreSessionPanel', () => {
  it('shows loading, then a fresh-start default plus one radio per session labelled title ?? firstPrompt with age and branch', async () => {
    let answer!: (r: PromptSessionsListRestorableResult) => void
    listRestorable.mockImplementation(() => new Promise((res) => { answer = res }))
    const el = render()
    expect(q(el, 'new-epic-restore-panel')?.textContent).toContain('Restore a session')
    expect(q(el, 'new-epic-restore-panel')?.textContent).toContain('no isolated worktree')
    expect(q(el, 'restore-session-loading')).not.toBeNull()
    expect(listRestorable).toHaveBeenCalledWith({ cwd: CWD })

    await act(async () => answer(result([
      session(ID_A, { title: 'Fix the login redirect', firstPrompt: 'the login page loops', gitBranch: 'main', mtimeMs: Date.now() - 5 * 60_000 }),
      session(ID_B, { title: null, firstPrompt: 'Add a dark mode toggle', mtimeMs: Date.now() - 3 * 3_600_000 }),
    ])))

    expect(q(el, 'restore-session-loading')).toBeNull()
    expect(radio(el, 'none')?.checked).toBe(true)
    expect(rowText(el, 'none')).toContain('Start a fresh session')
    expect(rowText(el, ID_A)).toContain('Fix the login redirect')
    expect(rowText(el, ID_A)).not.toContain('the login page loops')
    expect(rowText(el, ID_A)).toContain('5m ago')
    expect(rowText(el, ID_A)).toContain('main')
    expect(rowText(el, ID_B)).toContain('Add a dark mode toggle')
    expect(rowText(el, ID_B)).toContain('3h ago')
    expect(radio(el, ID_A)?.checked).toBe(false)
  })

  it('loads once per cwd and drops a late answer for a project it already left', async () => {
    const answers: Array<(r: PromptSessionsListRestorableResult) => void> = []
    listRestorable.mockImplementation(() => new Promise((res) => { answers.push(res) }))
    render({ cwd: '/p/one' })
    render({ cwd: '/p/one', excludeIds: [ID_B] })
    expect(listRestorable).toHaveBeenCalledTimes(1)

    const el = render({ cwd: '/p/two' })
    expect(listRestorable).toHaveBeenCalledTimes(2)
    expect(listRestorable.mock.calls[1][0]).toEqual({ cwd: '/p/two' })
    await act(async () => answers[1](result([session(ID_B, { title: 'From two' })])))
    await act(async () => answers[0](result([session(ID_A, { title: 'From one' })])))

    expect(radio(el, ID_B)).not.toBeNull()
    expect(radio(el, ID_A)).toBeNull()
  })

  it('says so when the project has no earlier sessions', async () => {
    const el = render()
    await flush()
    expect(q(el, 'restore-session-empty')?.textContent).toBe('No earlier Claude Code sessions in this project.')
    expect(el.querySelector('input[type="radio"]')).toBeNull()
  })

  it('a rejected load toasts and shows the reason inline instead of throwing', async () => {
    listRestorable.mockImplementation(async () => { throw new Error('transcripts unreadable') })
    const el = render()
    await flush()
    expect(q(el, 'restore-session-error')?.textContent).toContain('transcripts unreadable')
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && /transcripts unreadable/.test(t.message))).toBe(true)
    expect(el.querySelector('input[type="radio"]')).toBeNull()
  })

  it('a bridge that throws synchronously or answers garbage still renders, never throws', async () => {
    setApi({ promptSessions: { listRestorable: () => { throw new Error('bridge exploded') } } })
    const el = render()
    await flush()
    expect(q(el, 'restore-session-error')?.textContent).toContain('bridge exploded')

    setApi({ promptSessions: { listRestorable: async () => ({ nope: true }) } })
    render({ cwd: '/p/garbage' })
    await flush()
    expect(q(el, 'restore-session-empty')).not.toBeNull()
  })

  it('asks for a restart when the preload predates listRestorable', async () => {
    setApi({ promptSessions: {} })
    const el = render()
    await flush()
    expect(q(el, 'restore-session-missing-api')?.textContent).toContain('Restart the app to restore sessions')

    setApi(undefined)
    render({ cwd: '/p/no-api' })
    await flush()
    expect(q(el, 'restore-session-missing-api')).not.toBeNull()
    expect(listRestorable).not.toHaveBeenCalled()
  })

  it('hides headless runs until the checkbox is ticked; its label counts the hidden rows', async () => {
    listRestorable.mockImplementation(async () => result([
      session(ID_A, { title: 'Interactive' }),
      session(ID_H1, { title: 'claude -p run one', headless: true }),
      session(ID_H2, { title: 'claude -p run two', headless: true }),
    ]))
    const el = render()
    await flush()
    expect(radio(el, ID_A)).not.toBeNull()
    expect(radio(el, ID_H1)).toBeNull()
    expect(radio(el, ID_H2)).toBeNull()
    const toggle = q(el, 'restore-session-show-headless') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.closest('label')?.textContent).toContain('2 hidden')

    act(() => toggle.click())

    expect(toggle.checked).toBe(true)
    expect(radio(el, ID_H1)).not.toBeNull()
    expect(radio(el, ID_H2)).not.toBeNull()
    expect(toggle.closest('label')?.textContent).not.toContain('hidden')
  })

  it('leaves out sessions that are already open as a tab', async () => {
    listRestorable.mockImplementation(async () => result([session(ID_A), session(ID_B)]))
    const el = render({ excludeIds: [ID_A] })
    await flush()
    expect(radio(el, ID_A)).toBeNull()
    expect(radio(el, ID_B)).not.toBeNull()
  })

  it('reports the picked session, and null for a fresh start, through onSelect', async () => {
    const picked = session(ID_A, { title: 'Pick me' })
    listRestorable.mockImplementation(async () => result([picked, session(ID_B)]))
    const onSelect = vi.fn()
    const el = render({ onSelect })
    await flush()

    act(() => radio(el, ID_A)!.click())
    expect(onSelect).toHaveBeenLastCalledWith(picked)

    render({ onSelect, selectedId: ID_A })
    expect(radio(el, ID_A)?.checked).toBe(true)
    expect(radio(el, 'none')?.checked).toBe(false)

    act(() => radio(el, 'none')!.click())
    expect(onSelect).toHaveBeenLastCalledWith(null)
    expect(listRestorable).toHaveBeenCalledTimes(1)
  })

  it('warns on a recently active session to close it in its terminal first', async () => {
    listRestorable.mockImplementation(async () => result([session(ID_A, { recentlyActive: true }), session(ID_B)]))
    const el = render()
    await flush()
    expect(q(el, `restore-session-active-warning-${ID_A}`)?.textContent).toMatch(/close that session in its terminal first/i)
    expect(q(el, `restore-session-active-warning-${ID_B}`)).toBeNull()
  })

  it('read-only shows the adopted session id and the note, and never lists', async () => {
    const el = render({ readOnly: true, selectedId: ID_A, readOnlyNote: 'A saved draft keeps its own session.' })
    await flush()
    expect(listRestorable).not.toHaveBeenCalled()
    expect(q(el, 'restore-session-readonly-id')?.textContent).toContain(ID_A)
    expect(q(el, 'restore-session-readonly-note')?.textContent).toBe('A saved draft keeps its own session.')
    expect(el.querySelector('input')).toBeNull()
  })
})
