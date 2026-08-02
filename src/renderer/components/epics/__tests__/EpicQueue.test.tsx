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

describe('EpicQueue — Build toolbar action', () => {
  it('renders a Build button in the header', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('Build')
  })

  it('is disabled with a tooltip when resolveBuildTarget returns null', async () => {
    resolveBuildTargetMock.mockResolvedValue(null)
    const el = mount(<EpicQueue {...baseProps()} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title.length).toBeGreaterThan(0)
  })

  it('is enabled once resolveBuildTarget resolves a target, and clicking creates a build-tagged Epic via createPromptSession + approveProposed + chat send, then selects it', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
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

  it('right-clicking Build creates+selects the Epic without auto-sending, leaving the opening prompt as a pending draft', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-build"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    act(() => btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(created.id)

    const draft = takePendingEpicDraft(created.id)
    expect(draft).toContain('/builder')
  })

  it('the caret trigger next to Build also reaches the advanced (discuss-first) path', async () => {
    resolveBuildTargetMock.mockResolvedValue({ registry: 'npm', packageName: 'foo', versionBumpPolicy: 'conventional-commits', gates: [] })
    const onSelect = vi.fn()
    const el = mount(<EpicQueue {...baseProps()} onSelect={onSelect} />)
    await act(async () => {})
    const caret = el.querySelector('[data-testid="epic-queue-build-advanced"]') as HTMLButtonElement
    expect(caret).not.toBeNull()
    expect(caret.disabled).toBe(false)

    act(() => caret.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(sendSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(created.id)
    expect(takePendingEpicDraft(created.id)).toContain('/builder')
  })
})
