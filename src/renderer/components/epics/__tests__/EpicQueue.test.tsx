// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicQueue } from '../EpicQueue'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useChat } from '../../../state/chat'
import { takePendingEpicDraft } from '../../../lib/epicDraftText'
import type { EpicSnapshots } from '../../../lib/epicDerive'

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const approveProposedSpy = vi.fn()
const sendSpy = vi.fn()
const resolveBuildTargetMock = vi.fn()

;(globalThis as any).window.api = {
  app: { resolveBuildTarget: resolveBuildTargetMock },
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
  resolveBuildTargetMock.mockReset()
  resolveBuildTargetMock.mockResolvedValue(null)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function openActionsMenu(el: HTMLElement) {
  const trigger = el.querySelector('[data-testid="epic-queue-actions"]') as HTMLButtonElement
  act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  return el.querySelector('[data-testid="epic-queue-row-menu"]') as HTMLDivElement
}

describe('EpicQueue — Actions toolbar menu', () => {
  it('renders a single accent "Actions" button in the header, with no other toolbar buttons', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-actions"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toBe('Actions')
    expect(btn.className).toContain('bg-accent')
    expect(el.querySelector('[data-testid="epic-queue-build"]')).toBeNull()
  })

  it('opens a menu with New Epic, Build Project, and Build Project (discuss first)', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    const menu = openActionsMenu(el)
    const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['+ New Epic', 'Build Project', 'Build Project (discuss first)'])
  })

  it('New Epic item calls onNew', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onNew = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onNew={onNew} />)
    await act(async () => {})
    openActionsMenu(el)
    const btn = el.querySelector('[data-testid="epic-queue-new"]') as HTMLButtonElement
    act(() => btn.click())
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('Build Project item is disabled with a tooltip when resolveBuildTarget returns null', async () => {
    resolveBuildTargetMock.mockResolvedValue(null)
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    openActionsMenu(el)
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title.length).toBeGreaterThan(0)
  })

  it('is enabled once resolveBuildTarget resolves a target, and clicking Build Project creates a build-tagged Epic via createPromptSession + approveProposed + chat send, then selects it', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    openActionsMenu(el)
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [cwd, goalText, tag, status] = createPromptSessionSpy.mock.calls[0]
    expect(cwd).toBe('/home/bilko/Projects/alpha')
    expect(tag).toBe('build')
    expect(status).toBe('proposed')
    expect(goalText).toContain('/builder')

    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({
      tabId: created.id,
      sessionId: created.claudeSessionId,
      cwd: '/home/bilko/Projects/alpha',
      prompt: expect.stringContaining('/builder'),
    })
    expect(onSelect).toHaveBeenCalledWith(created.id)
  })

  it('"Build Project (discuss first)" creates+selects the Epic without auto-sending, leaving the opening prompt as a pending draft', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    openActionsMenu(el)
    const btn = el.querySelector('[data-testid="epic-queue-build-advanced"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(created.id)

    const draft = takePendingEpicDraft(created.id)
    expect(draft).toContain('/builder')
  })

  it('duplicate-Build guard: an existing non-completed build Epic for this cwd is opened instead of creating a second one', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const existing = {
      id: 'epic-existing-build',
      cwd: '/home/bilko/Projects/alpha',
      goalText: '/builder\n\nalready running',
      claudeSessionId: 'claude-existing',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      completedAt: null,
      tag: 'build' as const,
    }
    usePromptSessions.setState({ sessions: { [existing.id]: existing } })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    const menu = openActionsMenu(el)
    const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toContain('Open Build in progress')

    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(existing.id)
  })

  it('duplicate-Build guard still opens the in-flight Epic even when this project has no resolvable publish target', async () => {
    resolveBuildTargetMock.mockResolvedValue(null)
    const existing = {
      id: 'epic-existing-build-2',
      cwd: '/home/bilko/Projects/alpha',
      goalText: '/builder\n\nalready running',
      claudeSessionId: 'claude-existing-2',
      status: 'proposed' as const,
      createdAt: new Date().toISOString(),
      completedAt: null,
      tag: 'build' as const,
    }
    usePromptSessions.setState({ sessions: { [existing.id]: existing } })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    openActionsMenu(el)

    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(existing.id)
  })

  it('duplicate-Build guard also covers the discuss-first entry point', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const existing = {
      id: 'epic-existing-build-3',
      cwd: '/home/bilko/Projects/alpha',
      goalText: '/builder\n\nalready running',
      claudeSessionId: 'claude-existing-3',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      completedAt: null,
      tag: 'build' as const,
    }
    usePromptSessions.setState({ sessions: { [existing.id]: existing } })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    openActionsMenu(el)

    const btn = el.querySelector('[data-testid="epic-queue-build-advanced"]') as HTMLButtonElement
    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(existing.id)
  })
})
