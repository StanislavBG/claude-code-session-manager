// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EpicComposer, canCompose } from '../EpicComposer'
import { useChat } from '../../../state/chat'
import type { PromptSession } from '../../../state/promptSessions'
import type { EpicSnapshots } from '../../../lib/epicDerive'

const cancelSpy = vi.fn()
const saveBinarySpy = vi.fn(async () => ({ ok: true }))

;(globalThis as any).window.api = {
  chat: { cancel: cancelSpy },
  browser: { saveBinary: saveBinarySpy },
}

vi.mock('../../../state/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const dispatchSpy = vi.fn(async (..._args: unknown[]) => 'some-prd-slug')
vi.mock('../../../state/chat', async () => {
  const actual = await vi.importActual<typeof import('../../../state/chat')>('../../../state/chat')
  return { ...actual, dispatchPromptSessionToPrd: (a: string, b: string, c: string, d: string) => dispatchSpy(a, b, c, d) }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function rerender(el: React.ReactElement) {
  act(() => root!.render(el))
}

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function epic(overrides: Partial<PromptSession> = {}): PromptSession {
  return {
    id: 'epic-1',
    cwd: '/home/bilko/Projects/alpha',
    goalText: 'Ship the thing',
    claudeSessionId: 'sess-1',
    status: 'active',
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    tag: 'feature',
    ...overrides,
  }
}

function snapshots(overrides: Partial<EpicSnapshots> = {}): EpicSnapshots {
  return { sessions: {}, chats: {}, jobs: [], prds: [], ...overrides }
}

beforeEach(() => {
  useChat.setState({ chats: {} })
  cancelSpy.mockClear()
  saveBinarySpy.mockClear()
  dispatchSpy.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

describe('EpicComposer', () => {
  it('canCompose is false only for a completed Epic', () => {
    expect(canCompose(epic())).toBe(true)
    expect(canCompose(epic({ status: 'completed' }))).toBe(false)
  })

  it('defaults the action toggle from the Epic tag: feature/bug -> Dispatch, discussion -> Chat', () => {
    const featureEl = mount(createElement(EpicComposer, { epic: epic({ tag: 'feature' }), snapshots: snapshots() }))
    expect((featureEl.querySelector('[data-testid="epic-composer-action-dispatch"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    act(() => root?.unmount())
    container?.remove()

    const discussionEl = mount(createElement(EpicComposer, { epic: epic({ tag: 'discussion' }), snapshots: snapshots() }))
    expect((discussionEl.querySelector('[data-testid="epic-composer-action-chat"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
  })

  it('lets a manual override of the action toggle win over the tag default', () => {
    const el = mount(createElement(EpicComposer, { epic: epic({ tag: 'feature' }), snapshots: snapshots() }))
    const chatBtn = el.querySelector('[data-testid="epic-composer-action-chat"]') as HTMLButtonElement
    act(() => chatBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(chatBtn.getAttribute('aria-pressed')).toBe('true')
    expect((el.querySelector('[data-testid="epic-composer-action-dispatch"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false')
  })

  it('routes Chat to useChat.send with tabId=epicId, sessionId=claudeSessionId, cwd, prompt', async () => {
    const send = vi.fn()
    useChat.setState({ send } as any)
    const e = epic({ tag: 'discussion' })
    const el = mount(createElement(EpicComposer, { epic: e, snapshots: snapshots() }))
    const textarea = el.querySelector('[data-testid="epic-composer-textarea"]') as HTMLTextAreaElement
    act(() => setNativeValue(textarea, 'hello there'))
    const sendBtn = el.querySelector('[data-testid="epic-composer-send"]') as HTMLButtonElement
    await act(async () => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(send).toHaveBeenCalledWith({ tabId: 'epic-1', sessionId: 'sess-1', cwd: e.cwd, prompt: 'hello there' })
  })

  it('routes Dispatch as PRD to dispatchPromptSessionToPrd(epicId, cwd, text, tag)', async () => {
    const e = epic({ tag: 'bug' })
    const el = mount(createElement(EpicComposer, { epic: e, snapshots: snapshots() }))
    const textarea = el.querySelector('[data-testid="epic-composer-textarea"]') as HTMLTextAreaElement
    act(() => setNativeValue(textarea, 'fix the crash'))
    const sendBtn = el.querySelector('[data-testid="epic-composer-send"]') as HTMLButtonElement
    await act(async () => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dispatchSpy).toHaveBeenCalledWith('epic-1', e.cwd, 'fix the crash', 'bug')
  })

  it('shows Queue + Cancel when the Epic is running, and Cancel calls window.api.chat.cancel(epicId)', () => {
    const e = epic()
    const snaps = snapshots({ chats: { [e.id]: { ...useChat.getState().chats[e.id], running: true, queuedPosition: 0 } as any } })
    const el = mount(createElement(EpicComposer, { epic: e, snapshots: snaps }))
    expect((el.querySelector('[data-testid="epic-composer-send"]') as HTMLButtonElement).textContent).toBe('Queue')
    const cancelBtn = el.querySelector('[data-testid="epic-composer-cancel"]') as HTMLButtonElement
    expect(cancelBtn).toBeTruthy()
    act(() => cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(cancelSpy).toHaveBeenCalledWith('epic-1')
  })

  it('shows Send (no Cancel) when the Epic is not running', () => {
    const el = mount(createElement(EpicComposer, { epic: epic(), snapshots: snapshots() }))
    expect((el.querySelector('[data-testid="epic-composer-send"]') as HTMLButtonElement).textContent).toBe('Send')
    expect(el.querySelector('[data-testid="epic-composer-cancel"]')).toBeNull()
  })

  it('adds and removes an attachment chip', () => {
    const el = mount(createElement(EpicComposer, { epic: epic(), snapshots: snapshots() }))
    const fileInput = el.querySelector('[data-testid="epic-composer-attach-tray"] input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })))
    expect(el.textContent).toContain('shot.png')

    const removeBtn = Array.from(el.querySelectorAll('button')).find((b) => b.title === 'Remove') as HTMLButtonElement
    act(() => removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(el.textContent).not.toContain('shot.png')
  })

  it('clears text and attachments when the selected Epic switches', () => {
    const send = vi.fn()
    useChat.setState({ send } as any)
    const e1 = epic({ id: 'epic-1' })
    const e2 = epic({ id: 'epic-2', goalText: 'Different goal' })
    const el = mount(createElement(EpicComposer, { epic: e1, snapshots: snapshots() }))
    const textarea = el.querySelector('[data-testid="epic-composer-textarea"]') as HTMLTextAreaElement
    act(() => setNativeValue(textarea, 'draft for epic 1'))
    expect(textarea.value).toBe('draft for epic 1')

    rerender(createElement(EpicComposer, { epic: e2, snapshots: snapshots() }))
    const textareaAfter = el.querySelector('[data-testid="epic-composer-textarea"]') as HTMLTextAreaElement
    expect(textareaAfter.value).toBe('')
  })
})
