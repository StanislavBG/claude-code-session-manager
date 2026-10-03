// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicQueue } from '../EpicQueue'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useChat } from '../../../state/chat'
import type { EpicSnapshots } from '../../../lib/epicDerive'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const approveProposedSpy = vi.fn()
const sendSpy = vi.fn()

;(globalThis as any).window.api = {
  agents: { listPersonas: vi.fn().mockResolvedValue([]) },
  promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

const emptySnapshots: EpicSnapshots = { sessions: {}, chats: {}, jobs: [], prds: [] }

function baseProps() {
  return {
    epics: [],
    snapshots: emptySnapshots,
    events: {},
    selectedId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
  }
}

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy, approveProposed: approveProposedSpy })
  createPromptSessionSpy.mockClear()
  approveProposedSpy.mockClear()
  useChat.setState({ send: sendSpy })
  sendSpy.mockClear()
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: '/home/bilko/Projects/alpha' } as any], activeTabId: 'tab-1' })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('EpicQueue — Actions toolbar', () => {
  it('renders "+ New Session" as a button in the hot keys bar — no dropdown trigger', async () => {
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    expect(el.querySelector('[data-testid="epic-queue-actions"]')).toBeNull()
    const bar = el.querySelector('[data-testid="session-actions-bar"]') as HTMLDivElement
    expect(bar).not.toBeNull()
    const labels = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['+ New Session', 'New Macro'])
    expect((el.querySelector('[data-testid="epic-queue-new"]') as HTMLButtonElement).className).toContain('bg-accent')
  })

  it('renders no Build button in any state', async () => {
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    expect(el.querySelector('[data-testid="epic-queue-build"]')).toBeNull()
    expect(el.textContent).not.toMatch(/Set Up Build|Run Build|Open Build/)
    expect(el.querySelector('[data-testid="epic-queue-new"]')).not.toBeNull()
  })

  it('New Session button calls onNew', async () => {
    const onNew = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onNew={onNew} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-new"]') as HTMLButtonElement
    act(() => btn.click())
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})
