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
const resolveBuildTargetMock = vi.fn()

;(globalThis as any).window.api = {
  app: { resolveBuildTarget: resolveBuildTargetMock },
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
  resolveBuildTargetMock.mockReset()
  resolveBuildTargetMock.mockResolvedValue(null)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('EpicQueue — Actions toolbar', () => {
  it('renders every Action as its own button — no dropdown trigger', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    expect(el.querySelector('[data-testid="epic-queue-actions"]')).toBeNull()
    const bar = el.querySelector('[data-testid="session-actions-bar"]') as HTMLDivElement
    expect(bar).not.toBeNull()
    const labels = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['+ New Session', 'Run Build'])
    expect((el.querySelector('[data-testid="epic-queue-new"]') as HTMLButtonElement).className).toContain('bg-accent')
  })

  it('New Session button calls onNew', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onNew = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onNew={onNew} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-new"]') as HTMLButtonElement
    act(() => btn.click())
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('a null build target reads "Set Up Build" and stays enabled — unconfigured is not disabled', async () => {
    resolveBuildTargetMock.mockResolvedValue(null)
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.textContent).toBe('Set Up Build')
    expect(btn.disabled).toBe(false)
    expect(btn.title).toContain('build-target.json')
  })

  it('clicking Set Up Build mints a build-tagged Epic on the BOOTSTRAP goal — probe + write config + stop, never /builder', async () => {
    resolveBuildTargetMock.mockResolvedValue(null)
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement

    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [cwd, goalText, tag] = createPromptSessionSpy.mock.calls[0]
    expect(cwd).toBe('/home/bilko/Projects/alpha')
    expect(tag).toBe('build')
    // It names `.claude/agents/builder.md`, but never INVOKES the /builder
    // release skill — that would be the accidental publish this flow prevents.
    expect(goalText.startsWith('/builder')).toBe(false)
    expect(goalText).not.toContain('/builder\n')
    expect(goalText).toContain('session-manager-operations/architecture/build-target.json')
    expect(goalText).toContain('.claude/agents/builder.md')

    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ tabId: created.id }))
    expect(onSelect).toHaveBeenCalledWith(created.id)
  })

  it('Build is disabled only while the target lookup has not answered yet', async () => {
    let settle: (v: unknown) => void = () => {}
    resolveBuildTargetMock.mockReturnValue(new Promise((res) => { settle = res }))
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // ...and it does NOT flash "Set Up Build" before the answer arrives.
    expect(btn.textContent).toBe('Run Build')

    await act(async () => {
      settle(null)
    })
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toBe('Set Up Build')
  })

  it('is enabled once resolveBuildTarget resolves a target, and clicking Run Build creates a build-tagged Epic via createPromptSession + approveProposed + chat send, then selects it', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [cwd, goalText, tag] = createPromptSessionSpy.mock.calls[0]
    expect(cwd).toBe('/home/bilko/Projects/alpha')
    expect(tag).toBe('build')
    expect(goalText).toContain('/builder')

    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id, 'EpicQueue Run Build')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({
      tabId: created.id,
      sessionId: created.claudeSessionId,
      cwd: '/home/bilko/Projects/alpha',
      prompt: expect.stringContaining('/builder'),
    })
    expect(onSelect).toHaveBeenCalledWith(created.id)
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

    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    act(() => btn.click())
    await act(async () => {})

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(existing.id)
  })
})
