// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EpicChangesView } from '../EpicChangesView'
import { useChat } from '../../../state/chat'
import { useEpicReview } from '../../../state/epicReview'
import { toast } from '../../../state/toast'
import type { PromptSession } from '../../../state/promptSessions'
import type { EpicChanges, EpicChangeSection, DiffFile } from '../../../../preload/api'
import { flushAsync } from '../../../testUtils/domFlush'

vi.mock('../../../state/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const getSpy = vi.fn<(args: { cwd: string; epicId: string }) => Promise<EpicChanges>>()
const sendSpy = vi.fn()

;(globalThis as any).window.api = { epicChanges: { get: getSpy } }

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function epic(overrides: Partial<PromptSession> = {}): PromptSession {
  return {
    id: 'epic-1',
    cwd: '/home/u/alpha',
    goalText: 'Ship it',
    claudeSessionId: 'sess-1',
    status: 'active',
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    tag: 'feature',
    ...overrides,
  }
}

function file(path: string, lineNo = 1, text = 'const a = 1'): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: 1,
    deletions: 0,
    truncated: false,
    hunks: [
      {
        header: `@@ -1,1 +1,2 @@`,
        lines: [
          { kind: 'ctx', oldNo: 1, newNo: 1, text: 'ctx' },
          { kind: 'add', oldNo: null, newNo: lineNo, text },
        ],
      } as any,
    ],
  }
}

function section(overrides: Partial<EpicChangeSection> = {}): EpicChangeSection {
  return {
    kind: 'session',
    key: 'session:live',
    label: 'This session',
    base: 'aaaaaaaaaaaa',
    head: '1234567890abcdef',
    live: true,
    files: [file('src/a.ts', 2)],
    ...overrides,
  }
}

function ok(sections: EpicChangeSection[], truncated = false): EpicChanges {
  return { ok: true, epicId: 'epic-1', status: 'active', sections, truncated }
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

function setValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function addComment(side: 'old' | 'new', line: number, body: string) {
  act(() => q(`diff-line-comment-${side}-${line}`)!.click())
  const input = q('diff-comment-input') as HTMLTextAreaElement
  act(() => setValue(input, body))
  act(() => q('diff-comment-save')!.click())
}

beforeEach(() => {
  getSpy.mockReset()
  sendSpy.mockReset()
  sendSpy.mockReturnValue({ disposition: 'sent' })
  useChat.setState({ send: sendSpy } as any)
  useEpicReview.setState({ byEpic: {} })
  vi.mocked(toast.error).mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('EpicChangesView', () => {
  it('renders sections with label, short head, live badge and files', async () => {
    getSpy.mockResolvedValue(ok([section(), section({ kind: 'prd', key: 'prd:x', label: 'PRD x', live: false, head: 'feedfacecafebeef', files: [file('b.ts')], error: 'partial diff' })], true))
    mount(createElement(EpicChangesView, { promptSession: epic() }))
    await flushAsync()
    expect(getSpy).toHaveBeenCalledWith({ cwd: '/home/u/alpha', epicId: 'epic-1' })
    const sections = container!.querySelectorAll('[data-testid="epic-changes-section"]')
    expect(sections).toHaveLength(2)
    expect(sections[0].textContent).toContain('This session')
    expect(sections[0].textContent).toContain('12345678')
    expect(sections[0].textContent).not.toContain('123456789')
    expect(sections[0].querySelector('[data-testid="epic-changes-live"]')).not.toBeNull()
    expect(sections[1].querySelector('[data-testid="epic-changes-live"]')).toBeNull()
    expect(sections[1].textContent).toContain('partial diff')
    expect(container!.querySelectorAll('[data-testid="diff-file"]')).toHaveLength(2)
    expect(q('epic-changes-truncated')).not.toBeNull()
    expect(q('epic-changes-summary')!.textContent).toContain('2 files')
    expect(q('epic-changes-summary')!.textContent).toContain('+2')
  })

  it('shows the empty state', async () => {
    getSpy.mockResolvedValue(ok([]))
    mount(createElement(EpicChangesView, { promptSession: epic() }))
    await flushAsync()
    expect(q('epic-changes-empty')!.textContent).toBe('No changes recorded for this session yet.')
  })

  it('reports ok:false and rejections via toast.error', async () => {
    getSpy.mockResolvedValueOnce({ ok: false, reason: 'no worktree' })
    mount(createElement(EpicChangesView, { promptSession: epic() }))
    await flushAsync()
    expect(q('epic-changes-error')!.textContent).toContain('no worktree')
    expect(toast.error).toHaveBeenCalledTimes(1)
    getSpy.mockRejectedValueOnce(new Error('ipc boom'))
    act(() => q('epic-changes-refresh')!.click())
    await flushAsync()
    expect(q('epic-changes-error')!.textContent).toContain('ipc boom')
    expect(toast.error).toHaveBeenCalledTimes(2)
  })

  it('sends every comment as one prompt, then clears drafts and calls onSent', async () => {
    getSpy.mockResolvedValue(ok([section({ files: [file('src/a.ts', 2), file('src/b.ts', 2)] })]))
    const onSent = vi.fn()
    mount(createElement(EpicChangesView, { promptSession: epic(), onSent }))
    await flushAsync()
    const plus = container!.querySelectorAll('[data-testid="diff-line-comment-new-2"]')
    expect(plus).toHaveLength(2)
    for (const [i, body] of ['fix a', 'fix b'].entries()) {
      act(() => (container!.querySelectorAll('[data-testid="diff-line-comment-new-2"]')[i] as HTMLElement).click())
      act(() => setValue(q('diff-comment-input') as HTMLTextAreaElement, body))
      act(() => q('diff-comment-save')!.click())
    }
    const stored = useEpicReview.getState().byEpic['epic-1'].comments
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ sectionKey: 'session:live', sectionLabel: 'This session', commit: '1234567890abcdef' })
    expect(q('epic-changes-send')!.textContent).toBe('Send 2 comments')
    act(() => q('epic-changes-send')!.click())
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const arg = sendSpy.mock.calls[0][0]
    expect(arg).toMatchObject({ tabId: 'epic-1', sessionId: 'sess-1', cwd: '/home/u/alpha' })
    expect(arg.prompt).toContain('fix a')
    expect(arg.prompt).toContain('fix b')
    expect(useEpicReview.getState().byEpic['epic-1']).toBeUndefined()
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it('keeps drafts when send is refused', async () => {
    sendSpy.mockReturnValue({ disposition: 'refused', reason: 'terminal-attached' })
    getSpy.mockResolvedValue(ok([section()]))
    const onSent = vi.fn()
    mount(createElement(EpicChangesView, { promptSession: epic(), onSent }))
    await flushAsync()
    await addComment('new', 2, 'please fix')
    act(() => q('epic-changes-send')!.click())
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(useEpicReview.getState().byEpic['epic-1'].comments).toHaveLength(1)
    expect(onSent).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it.each([
    ['completed', 'Resume this session to send comments'],
    ['proposed', 'Approve this session to send comments'],
  ] as const)('disables Send for a %s Epic with a hint', async (status, hint) => {
    getSpy.mockResolvedValue(ok([section()]))
    mount(createElement(EpicChangesView, { promptSession: epic({ status }) }))
    await flushAsync()
    await addComment('new', 2, 'note')
    expect((q('epic-changes-send') as HTMLButtonElement).disabled).toBe(true)
    expect(q('epic-changes-send-hint')!.textContent).toBe(hint)
  })

  it('disables Send when there is nothing to send', async () => {
    getSpy.mockResolvedValue(ok([section()]))
    mount(createElement(EpicChangesView, { promptSession: epic() }))
    await flushAsync()
    expect((q('epic-changes-send') as HTMLButtonElement).disabled).toBe(true)
    expect(q('epic-changes-send-hint')).toBeNull()
  })

  it('Refresh refetches and lists outdated comments, which are still sent', async () => {
    getSpy.mockResolvedValueOnce(ok([section()]))
    mount(createElement(EpicChangesView, { promptSession: epic() }))
    await flushAsync()
    await addComment('new', 2, 'stale soon')
    expect(q('epic-changes-outdated')).toBeNull()
    getSpy.mockResolvedValueOnce(ok([section({ files: [file('src/a.ts', 7)] })]))
    act(() => q('epic-changes-refresh')!.click())
    await flushAsync()
    expect(getSpy).toHaveBeenCalledTimes(2)
    const outdated = q('epic-changes-outdated')!
    expect(outdated.textContent).toContain('Comments on lines no longer in the diff')
    expect(outdated.textContent).toContain('stale soon')
    act(() => q('epic-changes-send')!.click())
    expect(sendSpy.mock.calls[0][0].prompt).toContain('stale soon')
  })

  it('deletes an outdated comment', async () => {
    getSpy.mockResolvedValueOnce(ok([section()]))
    mount(createElement(EpicChangesView, { promptSession: epic() }))
    await flushAsync()
    await addComment('new', 2, 'gone')
    getSpy.mockResolvedValueOnce(ok([section({ files: [] })]))
    act(() => q('epic-changes-refresh')!.click())
    await flushAsync()
    const del = q('epic-changes-outdated')!.querySelector('button') as HTMLButtonElement
    act(() => del.click())
    expect(useEpicReview.getState().byEpic['epic-1'].comments).toHaveLength(0)
    expect(q('epic-changes-outdated')).toBeNull()
  })

  it('ignores a response that arrives after the Epic changed', async () => {
    let resolveFirst!: (v: EpicChanges) => void
    getSpy.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
    getSpy.mockResolvedValueOnce(ok([]))
    mount(createElement(EpicChangesView, { promptSession: epic() }))
    act(() => root!.render(createElement(EpicChangesView, { promptSession: epic({ id: 'epic-2' }) })))
    await flushAsync()
    expect(q('epic-changes-empty')).not.toBeNull()
    resolveFirst(ok([section()]))
    await flushAsync()
    expect(q('epic-changes-empty')).not.toBeNull()
    expect(container!.querySelectorAll('[data-testid="diff-file"]')).toHaveLength(0)
  })
})
