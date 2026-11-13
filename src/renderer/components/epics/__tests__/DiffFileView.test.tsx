// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { DiffFileView, type DiffFileViewProps } from '../DiffFileView'
import type { DiffFile } from '../../../../preload/api'
import type { ReviewComment } from '../../../lib/reviewMessage'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(props: Partial<DiffFileViewProps> = {}) {
  const full: DiffFileViewProps = {
    file: modifiedFile(),
    comments: [],
    onAddComment: vi.fn(),
    onUpdateComment: vi.fn(),
    onRemoveComment: vi.fn(),
    ...props,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(DiffFileView, full)))
  return { el: container, props: full }
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(el: Element | null, init: MouseEventInit = {}) {
  expect(el).not.toBeNull()
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
}

function keyDown(el: Element, init: KeyboardEventInit) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)

function modifiedFile(over: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/a.ts',
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: 2,
    deletions: 1,
    truncated: false,
    hunks: [
      {
        header: '@@ -10,3 +10,4 @@',
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 4,
        lines: [
          { kind: 'ctx', oldNo: 10, newNo: 10, text: 'const a = 1' },
          { kind: 'del', oldNo: 11, newNo: null, text: 'const b = 2' },
          { kind: 'add', oldNo: null, newNo: 11, text: 'const b = 3' },
          { kind: 'add', oldNo: null, newNo: 12, text: 'const c = 4' },
          { kind: 'ctx', oldNo: 12, newNo: 13, text: 'export {}' },
        ],
      },
    ],
    ...over,
  }
}

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    sectionKey: 'session:live',
    sectionLabel: 'Session',
    commit: null,
    path: 'src/a.ts',
    side: 'new',
    startLine: 11,
    endLine: 11,
    lineText: 'const b = 3',
    body: 'why 3?',
    createdAt: 0,
    ...over,
  }
}

describe('DiffFileView', () => {
  it('renders old/new gutters, markers and the hunk header for a modified file', () => {
    const { el } = mount()
    expect(q(el, 'diff-file-path')!.textContent).toBe('src/a.ts')
    expect(q(el, 'diff-file-status')!.textContent).toBe('modified')
    expect(el.textContent).toContain('+2')
    expect(el.textContent).toContain('-1')
    expect(q(el, 'diff-hunk-header')!.textContent).toBe('@@ -10,3 +10,4 @@')
    const rows = Array.from(el.querySelectorAll('[data-testid="diff-line"]'))
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['ctx', 'del', 'add', 'add', 'ctx'])
    const gutters = rows.map((r) => [
      r.querySelector('[data-testid="diff-old-no"]')!.textContent,
      r.querySelector('[data-testid="diff-new-no"]')!.textContent,
    ])
    expect(gutters).toEqual([
      ['10', '10'],
      ['11', ''],
      ['', '11'],
      ['', '12'],
      ['12', '13'],
    ])
    // + buttons: new side for add/ctx, old side for del
    expect(q(el, 'diff-line-comment-new-10')).not.toBeNull()
    expect(q(el, 'diff-line-comment-old-11')).not.toBeNull()
    expect(q(el, 'diff-line-comment-new-13')).not.toBeNull()
    expect(q(el, 'diff-line-comment-new-11')).not.toBeNull()
  })

  it('shows old -> new for a renamed file', () => {
    const { el } = mount({ file: modifiedFile({ status: 'renamed', oldPath: 'src/old.ts' }) })
    expect(q(el, 'diff-file-path')!.textContent).toBe('src/old.ts -> src/a.ts')
  })

  it('+ then Save calls onAddComment with the exact anchor and body', () => {
    const { el, props } = mount()
    click(q(el, 'diff-line-comment-new-12'))
    const ta = q(el, 'diff-comment-input') as HTMLTextAreaElement
    // blank Save does nothing
    click(q(el, 'diff-comment-save'))
    expect(props.onAddComment).not.toHaveBeenCalled()
    setNativeValue(ta, '  rename c  ')
    click(q(el, 'diff-comment-save'))
    expect(props.onAddComment).toHaveBeenCalledWith(
      { path: 'src/a.ts', side: 'new', startLine: 12, endLine: 12, lineText: 'const c = 4' },
      'rename c',
    )
    expect(q(el, 'diff-comment-input')).toBeNull()
  })

  it('Ctrl+Enter saves an old-side comment', () => {
    const { el, props } = mount()
    click(q(el, 'diff-line-comment-old-11'))
    const ta = q(el, 'diff-comment-input') as HTMLTextAreaElement
    setNativeValue(ta, 'keep 2')
    keyDown(ta, { key: 'Enter', ctrlKey: true })
    expect(props.onAddComment).toHaveBeenCalledWith(
      { path: 'src/a.ts', side: 'old', startLine: 11, endLine: 11, lineText: 'const b = 2' },
      'keep 2',
    )
  })

  it('shift-click extends the anchor to a range with joined lineText', () => {
    const { el, props } = mount()
    click(q(el, 'diff-line-comment-new-13'))
    click(q(el, 'diff-line-comment-new-11'), { shiftKey: true })
    setNativeValue(q(el, 'diff-comment-input') as HTMLTextAreaElement, 'block')
    click(q(el, 'diff-comment-save'))
    expect(props.onAddComment).toHaveBeenCalledWith(
      {
        path: 'src/a.ts',
        side: 'new',
        startLine: 11,
        endLine: 13,
        lineText: 'const b = 3\nconst c = 4\nexport {}',
      },
      'block',
    )
  })

  it('Escape cancels without saving', () => {
    const { el, props } = mount()
    click(q(el, 'diff-line-comment-new-10'))
    const ta = q(el, 'diff-comment-input') as HTMLTextAreaElement
    setNativeValue(ta, 'nope')
    keyDown(ta, { key: 'Escape' })
    expect(q(el, 'diff-comment-input')).toBeNull()
    expect(props.onAddComment).not.toHaveBeenCalled()
  })

  it('renders saved comments with Edit and Delete', () => {
    const { el, props } = mount({ comments: [comment()] })
    expect(q(el, 'diff-comment-c1')!.textContent).toContain('why 3?')
    click(q(el, 'diff-comment-delete-c1'))
    expect(props.onRemoveComment).toHaveBeenCalledWith('c1')
    click(q(el, 'diff-comment-edit-c1'))
    const ta = q(el, 'diff-comment-edit-input') as HTMLTextAreaElement
    expect(ta.value).toBe('why 3?')
    setNativeValue(ta, 'why not 4?')
    click(q(el, 'diff-comment-edit-save'))
    expect(props.onUpdateComment).toHaveBeenCalledWith('c1', 'why not 4?')
  })

  it('collapse toggle hides and shows the body', () => {
    const { el } = mount()
    expect(el.querySelectorAll('[data-testid="diff-line"]').length).toBe(5)
    click(q(el, 'diff-file-toggle'))
    expect(el.querySelectorAll('[data-testid="diff-line"]').length).toBe(0)
    click(q(el, 'diff-file-toggle'))
    expect(el.querySelectorAll('[data-testid="diff-line"]').length).toBe(5)
  })

  it('defaultCollapsed starts collapsed', () => {
    const { el } = mount({ defaultCollapsed: true })
    expect(el.querySelectorAll('[data-testid="diff-line"]').length).toBe(0)
  })

  it('binary files show the no-preview notice', () => {
    const { el } = mount({ file: modifiedFile({ binary: true, hunks: [] }) })
    expect(q(el, 'diff-file-notice')!.textContent).toBe('Binary file, no preview')
  })

  it('tooLarge and truncated files show what is hidden', () => {
    const big = mount({ file: modifiedFile({ tooLarge: true, hunks: [] }) })
    expect(q(big.el, 'diff-file-notice')!.textContent).toMatch(/too large/)
    act(() => root?.unmount())
    container?.remove()
    const cut = mount({ file: modifiedFile({ truncated: true }) })
    expect(q(cut.el, 'diff-file-notice')!.textContent).toMatch(/truncated/)
    expect(cut.el.querySelectorAll('[data-testid="diff-line"]').length).toBe(5)
  })

  it('readOnly hides every + button', () => {
    const { el } = mount({ readOnly: true, comments: [comment()] })
    expect(el.querySelectorAll('[data-testid^="diff-line-comment-"]').length).toBe(0)
    expect(q(el, 'diff-comment-c1')).not.toBeNull()
  })
})
